"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";

import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  createAnnouncement,
  fetchAnnouncementAudience,
  patchAnnouncement,
  type AnnouncementDraft,
} from "@/lib/platform-api";
import type { Audience } from "@/lib/announcements";
import { SEVERITIES } from "@/lib/announcements";

// Every action here gates on `mass-send`, and that gate is the point of #150.
//
// The surface this replaces — apps/web's /api/admin/platform-announcements —
// has NO capability check: its middleware enforces a session and nothing more,
// so any operator with a login can publish to every merchant of every product.
// Nobody is over-privileged today because every operator currently holds all
// twelve capabilities, which is exactly why the gap is easy to leave: it costs
// nothing until the first narrow grant, and then it costs silence.
//
// `mass-send` rather than `platform` is routes.ts's own choice for this
// surface — "where the route exists only to perform one high-blast-radius act,
// name the verb instead".
//
// No console-side audit row, unlike the CRM writes. platform-api records
// `announcements.draft`, `.publish`, `.expire` and `.edit` in the same
// transaction as the write, so an audit here would be a second, weaker record
// of the same act — and one that could disagree with the first.

export type AnnouncementActionResult = { ok: true } | { ok: false; message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to send announcements.";

// Matches the API's own bound. Enforced here too so an over-long title fails
// with a sentence rather than an opaque 422.
const MAX_TITLE = 200;

/**
 * Run `work` behind the `mass-send` gate.
 *
 * Internal error strings — transport failures, upstream detail — must never
 * reach the UI verbatim, so callers get a per-verb message instead.
 */
async function withMassSend<T>(
  work: () => Promise<T>,
  failureMessage: string,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    await checkOperatorCapabilityLive(session, "mass-send");
    return { ok: true, value: await work() };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof CapabilityError ? NO_PERMISSION_MESSAGE : failureMessage,
    };
  }
}

/**
 * Preview who a send would reach.
 *
 * Gated with the writes although it mutates nothing: the preview exists to
 * inform a send, and showing the estate's tenant counts to an operator who may
 * not send is a disclosure that buys nobody anything.
 */
export async function previewAudienceAction(
  products: string[],
  statuses: string[],
): Promise<{ ok: true; audience: Audience } | { ok: false; message: string }> {
  const result = await withMassSend(
    () => fetchAnnouncementAudience(products, statuses),
    "The audience could not be counted right now.",
  );
  return result.ok ? { ok: true, audience: result.value } : result;
}

export async function createAnnouncementAction(
  draft: AnnouncementDraft,
): Promise<AnnouncementActionResult> {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title.length === 0) return { ok: false, message: "Give the announcement a title." };
  if (title.length > MAX_TITLE) {
    return { ok: false, message: `Titles are limited to ${MAX_TITLE} characters.` };
  }
  if (body.length === 0) return { ok: false, message: "Write the announcement before sending." };
  if (!SEVERITIES.includes(draft.severity)) {
    // Refused rather than defaulted: the column has a CHECK constraint, so a
    // typo'd severity would otherwise surface as a 500 from the database.
    return { ok: false, message: "Choose a severity." };
  }

  const result = await withMassSend(
    () => createAnnouncement({ ...draft, title, body }),
    "The announcement could not be saved.",
  );
  if (!result.ok) return result;

  revalidatePath("/platform/announcements");
  return { ok: true };
}

/**
 * Publish a draft, or expire a live announcement.
 *
 * Publishing is irrevocable and expiring is its only remedy — there is no
 * unsend. An announcement that went out wrong is ENDED, and the merchants who
 * already saw it have already seen it. The UI should say that rather than
 * offer a delete that cannot mean what it looks like.
 */
export async function updateAnnouncementAction(
  id: string,
  change: { publish?: boolean; ends_at?: string | null },
): Promise<AnnouncementActionResult> {
  const result = await withMassSend(
    () => patchAnnouncement(id, change),
    "The announcement could not be updated.",
  );
  return result.ok ? { ok: true } : result;
}
