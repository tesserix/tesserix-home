// lib/waitlist/announce.ts — the automatic launch announcement.
//
// The whole point of the waitlist: when a product's status flips from
// "coming-soon" to "available" in products-data.ts and that deploys, everyone
// waiting on it gets told. There is no second switch to remember and no manual
// mail merge — shipping the product IS the trigger.
//
// Safety, because this sends real mail to real people with no human in the
// loop:
//   1. `claimLaunchAnnouncement` is an atomic insert — only one caller wins,
//      so concurrent pods/cron ticks cannot both announce.
//   2. Each recipient is marked notified the moment their send succeeds, so a
//      crash mid-run resumes without re-mailing anyone.
//   3. WAITLIST_ANNOUNCE_ENABLED=false disables sending entirely (kill switch).
//   4. dryRun reports exactly who would be mailed, changing nothing.

import {
  claimLaunchAnnouncement,
  listAnnouncedProducts,
  listPendingSubscribers,
  markSubscriberNotified,
  recordAnnouncementRecipients,
} from "@/lib/db/product-waitlist";
import { logger } from "@/lib/logger";
import { sendViaSendGrid } from "@/lib/sendgrid/send";
import {
  launchedProductSlugs,
  productTitle,
} from "@/app/(marketing)/products/[slug]/products-data";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tesserix.app";
const FROM =
  process.env.WAITLIST_FROM_EMAIL ?? "hello@tesserix.app";

/** Kill switch. Anything other than an explicit "false" leaves sending on. */
function announcingEnabled(): boolean {
  return (process.env.WAITLIST_ANNOUNCE_ENABLED ?? "true").trim() !== "false";
}

export interface AnnounceProductResult {
  readonly productSlug: string;
  readonly announced: boolean;
  readonly sent: number;
  readonly failed: number;
  readonly skippedReason?: string;
}

export interface AnnounceRunResult {
  readonly results: AnnounceProductResult[];
  readonly dryRun: boolean;
}

function unsubscribeUrl(token: string): string {
  return `${SITE_URL}/api/waitlist/unsubscribe?token=${encodeURIComponent(token)}`;
}

function productUrl(slug: string): string {
  return `${SITE_URL}/products/${slug}`;
}

/** Plain-text body. Every marketing mail needs one — some clients show only this. */
function textBody(title: string, slug: string, token: string): string {
  return [
    `${title} is live.`,
    "",
    `You asked us to let you know when ${title} launched. It has.`,
    "",
    productUrl(slug),
    "",
    "— The Tesserix team",
    "",
    "You're receiving this because you joined the waitlist for this product.",
    `Unsubscribe: ${unsubscribeUrl(token)}`,
  ].join("\n");
}

function htmlBody(title: string, slug: string, token: string): string {
  // Inline styles only, table-free, no external assets — the lowest common
  // denominator that renders the same in Gmail, Outlook and Apple Mail.
  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f5f5f4;">
  <div style="max-width:34rem;margin:0 auto;padding:40px 24px;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;">
    <p style="font:600 12px/1 ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#777;margin:0 0 24px;">Tesserix</p>
    <h1 style="font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:0 0 16px;">${title} is live.</h1>
    <p style="color:#444;margin:0 0 24px;">
      You asked us to let you know when ${title} launched. It has — it's ready for you now.
    </p>
    <p style="margin:0 0 32px;">
      <a href="${productUrl(slug)}"
         style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">
        Take a look
      </a>
    </p>
    <p style="color:#444;margin:0 0 32px;">— The Tesserix team</p>
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:0 0 16px;">
    <p style="font-size:13px;color:#888;margin:0;">
      You're receiving this because you joined the waitlist for this product.
      <a href="${unsubscribeUrl(token)}" style="color:#888;">Unsubscribe</a>.
    </p>
  </div>
</body></html>`;
}

/**
 * Announces one product to everyone still waiting on it.
 *
 * Claims the announcement first: if another run already has it, this returns
 * immediately without sending. That claim is what makes the job safe to run on
 * every deploy and on a schedule at the same time.
 */
export async function announceProduct(
  productSlug: string,
  opts: { dryRun?: boolean } = {},
): Promise<AnnounceProductResult> {
  const title = productTitle(productSlug);
  const pending = await listPendingSubscribers(productSlug);

  if (opts.dryRun) {
    return {
      productSlug,
      announced: false,
      sent: 0,
      failed: 0,
      skippedReason: `dry-run: would email ${pending.length} subscriber(s)`,
    };
  }

  if (!announcingEnabled()) {
    return {
      productSlug,
      announced: false,
      sent: 0,
      failed: 0,
      skippedReason: "WAITLIST_ANNOUNCE_ENABLED=false",
    };
  }

  // Claim before sending. Losing the race means someone else is handling it.
  if (!(await claimLaunchAnnouncement(productSlug))) {
    return {
      productSlug,
      announced: false,
      sent: 0,
      failed: 0,
      skippedReason: "already announced",
    };
  }

  let sent = 0;
  let failed = 0;

  for (const sub of pending) {
    const result = await sendViaSendGrid({
      to: sub.email,
      from: FROM,
      subject: `${title} is live`,
      htmlBody: htmlBody(title, productSlug, sub.unsubscribeToken),
      textBody: textBody(title, productSlug, sub.unsubscribeToken),
      customArgs: {
        product: productSlug,
        kind: "waitlist-launch",
        template_key: "product_launch_v1",
      },
    });

    if (result.ok) {
      // Mark immediately, not in a batch at the end: a crash here must not
      // re-mail the people already reached on the next run.
      await markSubscriberNotified(sub.id);
      sent += 1;
    } else {
      failed += 1;
      logger.warn("[Waitlist] launch email failed", {
        productSlug,
        status: result.status,
        error: result.errorMessage,
      });
    }
  }

  await recordAnnouncementRecipients(productSlug, sent);
  logger.info("[Waitlist] launch announced", { productSlug, sent, failed });

  return { productSlug, announced: true, sent, failed };
}

/**
 * The automatic pass: every product that is live but has never been announced
 * gets announced. Safe to call on every deploy and on a schedule.
 *
 * First run baselines the products that were ALREADY live when this shipped
 * (Mark8ly, FanZone): they get an announcement row with zero recipients,
 * because their waitlists are empty — the signup form only appears on
 * coming-soon products. That baseline is deliberate; it means a future signup
 * can never trigger a retroactive "we launched" email for a product that
 * launched long ago.
 */
export async function announcePendingLaunches(
  opts: { dryRun?: boolean } = {},
): Promise<AnnounceRunResult> {
  const live = launchedProductSlugs();
  const already = await listAnnouncedProducts();
  const results: AnnounceProductResult[] = [];

  for (const slug of live) {
    if (already.has(slug)) continue;
    results.push(await announceProduct(slug, opts));
  }

  return { results, dryRun: opts.dryRun === true };
}
