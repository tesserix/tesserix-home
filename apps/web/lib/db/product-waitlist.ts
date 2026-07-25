// lib/db/product-waitlist.ts — the "notify me when this launches" list.
//
// Backs the product-page signup form, the one-click unsubscribe link, and the
// automatic launch announcement. See db/migrations/0014_product_waitlist.sql
// for why this is its own table rather than a flavour of `leads`.

import { tesserixQuery } from "@/lib/db/tesserix";

export interface WaitlistSubscriber {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly unsubscribeToken: string;
}

export interface WaitlistCounts {
  readonly productSlug: string;
  readonly total: number;
  readonly pending: number;
}

/**
 * Records a signup. Idempotent by (product_slug, lower(email)): signing up
 * twice is a no-op rather than an error, because a double-submit or a second
 * visit is the user's intent restated, not a failure.
 *
 * Re-subscribing after an unsubscribe clears unsubscribed_at — the person is
 * explicitly asking to hear from us again.
 */
export async function subscribeToWaitlist(input: {
  productSlug: string;
  email: string;
  name?: string;
  source?: string;
}): Promise<void> {
  await tesserixQuery(
    `INSERT INTO product_waitlist (product_slug, email, name, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_slug, lower(email)) DO UPDATE SET
       name            = COALESCE(NULLIF(EXCLUDED.name, ''), product_waitlist.name),
       unsubscribed_at = NULL,
       updated_at      = now()`,
    [
      input.productSlug,
      input.email,
      input.name?.trim() || null,
      input.source ?? "product-page",
    ],
  );
}

/**
 * Everyone still owed a launch email for this product: subscribed, not
 * unsubscribed, not already told.
 */
export async function listPendingSubscribers(
  productSlug: string,
): Promise<WaitlistSubscriber[]> {
  const res = await tesserixQuery<{
    id: string;
    email: string;
    name: string | null;
    unsubscribe_token: string;
  }>(
    `SELECT id, email, name, unsubscribe_token
       FROM product_waitlist
      WHERE product_slug = $1
        AND notified_at IS NULL
        AND unsubscribed_at IS NULL
      ORDER BY created_at`,
    [productSlug],
  );
  return res.rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    unsubscribeToken: r.unsubscribe_token,
  }));
}

/**
 * Marks one subscriber as told. Called per successful send rather than in a
 * batch at the end, so a crash mid-run cannot re-mail the people already
 * reached — at-least-once delivery with per-recipient idempotency.
 */
export async function markSubscriberNotified(id: string): Promise<void> {
  await tesserixQuery(
    `UPDATE product_waitlist
        SET notified_at = now(), updated_at = now()
      WHERE id = $1 AND notified_at IS NULL`,
    [id],
  );
}

/** Honours an unsubscribe link. Returns false when the token is unknown. */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  const res = await tesserixQuery(
    `UPDATE product_waitlist
        SET unsubscribed_at = now(), updated_at = now()
      WHERE unsubscribe_token = $1
      RETURNING id`,
    [token],
  );
  return res.rowCount !== null && res.rowCount > 0;
}

/**
 * Claims the right to announce a product's launch.
 *
 * Returns true only for the caller that inserted the row. The announce job is
 * automatic and may run on several pods at once, so this is what stops two
 * concurrent runs both deciding to mail the list.
 */
export async function claimLaunchAnnouncement(
  productSlug: string,
): Promise<boolean> {
  const res = await tesserixQuery(
    `INSERT INTO product_launch_announcements (product_slug)
     VALUES ($1)
     ON CONFLICT (product_slug) DO NOTHING
     RETURNING product_slug`,
    [productSlug],
  );
  return res.rowCount !== null && res.rowCount > 0;
}

/** Records how many people the announcement actually reached. */
export async function recordAnnouncementRecipients(
  productSlug: string,
  recipients: number,
): Promise<void> {
  await tesserixQuery(
    `UPDATE product_launch_announcements
        SET recipients = $2
      WHERE product_slug = $1`,
    [productSlug, recipients],
  );
}

/** Products already announced — the announce job skips these. */
export async function listAnnouncedProducts(): Promise<Set<string>> {
  const res = await tesserixQuery<{ product_slug: string }>(
    `SELECT product_slug FROM product_launch_announcements`,
  );
  return new Set(res.rows.map((r) => r.product_slug));
}

/** Per-product signup counts, for the admin view. */
export async function waitlistCounts(): Promise<WaitlistCounts[]> {
  const res = await tesserixQuery<{
    product_slug: string;
    total: string;
    pending: string;
  }>(
    `SELECT product_slug,
            COUNT(*)                                          AS total,
            COUNT(*) FILTER (WHERE notified_at IS NULL
                               AND unsubscribed_at IS NULL)   AS pending
       FROM product_waitlist
      GROUP BY product_slug
      ORDER BY COUNT(*) DESC`,
  );
  return res.rows.map((r) => ({
    productSlug: r.product_slug,
    total: Number(r.total),
    pending: Number(r.pending),
  }));
}
