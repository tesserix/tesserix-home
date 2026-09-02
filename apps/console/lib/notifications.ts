import type { Proposal } from "@/lib/secrets";

/**
 * What the bell shows.
 *
 * A notification is DERIVED — a ticket that arrived, a merchant who replied,
 * or a secrets-access proposal still waiting on `rotate-credentials` — read
 * from the rows/PRs themselves. There is no notifications table and no
 * writer, so an item cannot drift from the thing it describes and cannot
 * outlive it. The two ticket kinds link to a ticket a human can open; the
 * proposal kind links to the review a human can act on.
 */

/**
 * Every kind a `NotificationItem` can carry. This array is the source of
 * truth: `NotificationKind` is derived FROM it (`(typeof
 * NOTIFICATION_KINDS)[number]`), not the other way around. That direction is
 * load-bearing, not stylistic — a `NotificationKind` union declared first
 * with this array typed as `readonly NotificationKind[]` would let the array
 * stay a stale 3-element literal after the union grows to four, with no
 * compile error anywhere, because a shorter array is still assignable to
 * that element type. Deriving the type from the array instead makes adding a
 * kind without adding it here a type error at every place a full
 * `NotificationKind` is expected (`CAPABILITY_FOR_KIND` in `route.ts`, the
 * `assertNever` switches in `notification-bell.tsx`).
 *
 * `notification-bell.tsx`'s shape validator checks an incoming item's `kind`
 * against this same array — an unlisted kind fails `hasRecognisedKind`,
 * which fails `isNotificationFeedShape`, which disables the bell entirely
 * (`UNAVAILABLE`) for every operator on every page. That failure mode is why
 * this being the actual, compiler-enforced source of truth matters more than
 * it looks.
 */
export const NOTIFICATION_KINDS = [
  "ticket_created",
  "merchant_reply",
  "access_proposal_open",
  "access_proposal_merged",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface TicketNotification {
  /** `${kind}:${row id}` — the merged list holds every kind, and a bare row
   *  id could collide across sources. */
  readonly id: string;
  // Narrowed to the two ticket-shaped literals, not the whole
  // `NotificationKind` union — with `AccessProposalNotification` now a
  // sibling member, a `kind` field typed to the full union here would let
  // TypeScript believe a `TicketNotification` could carry
  // `"access_proposal_open"`, which defeats discrimination: a `switch` over
  // `NotificationItem["kind"]` could no longer narrow `item` to the right
  // interface per case, and an exhaustiveness check (`notification-bell.tsx`'s
  // `assertNever`) would stop being trustworthy.
  readonly kind: "ticket_created" | "merchant_reply";
  /** The ticket's uuid. The detail route keys on this, never the number. */
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly productId: string;
  readonly subject: string;
  readonly actor: string;
  readonly at: string;
}

/**
 * An open pull request against `tesserix-k8s` proposing to add or remove a
 * secret reader — `fetchProposals()` in `lib/secrets-api.ts`, which the
 * reviews queue page already renders. Reaching the bell means only
 * `rotate-credentials` holders are told: someone holding `platform` (the
 * surface) but not `rotate-credentials` (the verb) cannot approve or merge
 * a proposal, so surfacing one to them would be exactly the noise a
 * capability-filtered feed exists to remove — see route.ts's
 * `CAPABILITY_FOR_KIND` comment.
 *
 * No `actor` field: `Proposal` carries a GitHub `author`, but 3b-ii's
 * design deliberately does not surface who raised a secrets change (the
 * point is that anyone with the right capability can act on it, not who
 * asked) — so this interface has nothing to put there, unlike
 * `TicketNotification`.
 */
export interface AccessProposalNotification {
  /** `${kind}:${pull request number}` — same collision-avoidance reasoning
   *  as `TicketNotification.id`. */
  readonly id: string;
  readonly kind: "access_proposal_open";
  /** The pull-request number; the review detail route keys on this. */
  readonly number: number;
  readonly title: string;
  /** The namespace/app targets this proposal touches — see `Proposal.targets`
   *  in `lib/secrets.ts`. Always an array, never `undefined`: the parser
   *  boundary in `secrets.ts` already normalises GitHub's possible `null`
   *  to `[]`. */
  readonly targets: string[];
  /**
   * `undefined` when `secrets-api` could not parse the GitHub PR's
   * timestamp and silently discarded that error (`gitops/review.go:61`,
   * `created, _ := time.Parse(...)`) — see `Proposal.createdAt`'s doc
   * comment in `lib/secrets.ts`. Ruling: an item with no `at` sorts OLDEST
   * in `mergeEvents` and is never counted as unread by `countUnread` — see
   * both functions' comments below for why.
   */
  readonly at: string | undefined;
}

/**
 * A proposal the viewing operator raised has merged: their app now has a
 * reader. Unlike every other kind, this one is addressed to a PERSON — the
 * capability check alone cannot express "yours" — so it carries the subject
 * it is for and route.ts requires that subject to match the session.
 */
export interface AccessProposalMergedNotification {
  readonly id: string;
  readonly kind: "access_proposal_merged";
  readonly number: number;
  readonly title: string;
  readonly targets: string[];
  /** The Zitadel subject this is FOR. Never optional: an item that cannot
   *  name its recipient must not be built — see toMergedProposalEvent. */
  readonly recipientSub: string;
  /** The MERGE time, not the creation time. A proposal that waited a week
   *  would otherwise arrive older than the read watermark and so pre-read. */
  readonly at: string;
}

// A discriminated union: two kinds read from ticket/reply rows, one read
// from an open pull request, one read from a merged pull request.
// `AccessProposalNotification` was introduced as its own interface (rather
// than reusing TicketNotification's fields) so this addition and the
// ticket-kind refactor stayed separately bisectable.
export type NotificationItem =
  | TicketNotification
  | AccessProposalNotification
  | AccessProposalMergedNotification;

export interface NotificationFeed {
  readonly items: readonly NotificationItem[];
  readonly unread: number;
  readonly lastSeenAt: string | null;
}

export const FEED_LIMIT = 20;
export const FEED_WINDOW_DAYS = 14;

export interface TicketEventRow {
  readonly id: string;
  readonly product_id: string;
  readonly ticket_number: string;
  readonly subject: string;
  readonly submitted_by_name: string;
  readonly created_at: string;
}

export interface ReplyEventRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly author_name: string;
  readonly created_at: string;
  readonly ticket_number: string;
  readonly product_id: string;
  readonly subject: string;
}

export function toTicketEvent(row: TicketEventRow): TicketNotification {
  return {
    id: `ticket_created:${row.id}`,
    kind: "ticket_created",
    ticketId: row.id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.submitted_by_name || "Unknown sender",
    at: row.created_at,
  };
}

export function toReplyEvent(row: ReplyEventRow): TicketNotification {
  return {
    id: `merchant_reply:${row.id}`,
    kind: "merchant_reply",
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.author_name || "Merchant",
    at: row.created_at,
  };
}

/** Maps one open pull request (`fetchProposals()` in `lib/secrets-api.ts`)
 *  to the notification the bell renders. `proposal.createdAt` passes
 *  through unchanged, `undefined` included — see
 *  `AccessProposalNotification.at`'s doc comment for what an absent value
 *  means downstream. */
export function toProposalEvent(proposal: Proposal): AccessProposalNotification {
  return {
    id: `access_proposal_open:${proposal.number}`,
    kind: "access_proposal_open",
    number: proposal.number,
    title: proposal.title,
    targets: proposal.targets,
    at: proposal.createdAt,
  };
}

/**
 * Maps a merged proposal to its notification, or `undefined` when the
 * proposal cannot support one.
 *
 * Returning `undefined` rather than a partly-filled item is the point: a
 * proposal raised before the `requested-by:` trailer existed has no
 * requester, and an item with no recipient cannot be filtered to one — it
 * would either reach everybody or nobody, and "everybody" is one operator
 * seeing another's activity.
 */
export function toMergedProposalEvent(
  proposal: Proposal,
): AccessProposalMergedNotification | undefined {
  if (!proposal.requestedBy || !proposal.mergedAt) return undefined;
  return {
    id: `access_proposal_merged:${proposal.number}`,
    kind: "access_proposal_merged",
    number: proposal.number,
    title: proposal.title,
    targets: proposal.targets,
    recipientSub: proposal.requestedBy,
    at: proposal.mergedAt,
  };
}

/**
 * Orders two items newest-first, with one exception: an item whose `at` is
 * `undefined` (today, only an `AccessProposalNotification` whose upstream
 * timestamp failed to parse — see its doc comment) sorts as the OLDEST item
 * in the list, never the newest.
 *
 * This is a deliberate choice, not a fallout of comparing `undefined` with
 * a string (which the naive `x.at < y.at` form used to do, always false in
 * both directions, silently leaving undated items in whatever order
 * `Array.flat()` happened to produce). Sorting an unknown date as the
 * newest would pin an undated proposal at the top of the feed forever —
 * `countUnread` would then never see a real timestamp exceed it (there
 * isn't one to compare against), so it would count as perpetually unread.
 * A bell that can never be cleared for one specific item is the exact
 * failure `countUnread`'s own doc comment argues against for the
 * null-`lastSeenAt` case. Sorting unknown as oldest is also the honest
 * reading of "we don't know when this happened": absence of evidence that
 * it's new is not evidence that it's new.
 *
 * Exported (only `mergeEvents` below uses it in production code) so
 * `notifications.test.ts` can assert its symmetry directly —
 * `cmp(x, y) === -cmp(y, x)` for the two-undefined case — rather than
 * through `Array.prototype.sort`, whose small-array insertion sort does not
 * reliably query both comparison directions and so cannot be trusted to
 * catch a broken comparator here. See that test for the failure this
 * guards against.
 */
export function compareByAtDescending(x: NotificationItem, y: NotificationItem): number {
  if (x.at === undefined && y.at === undefined) return 0;
  if (x.at === undefined) return 1;
  if (y.at === undefined) return -1;
  return x.at < y.at ? 1 : x.at > y.at ? -1 : 0;
}

/** Newest first, then truncated — truncating before sorting would drop new
 *  events from whichever source happened to be longer.
 *
 *  Takes an array of sources rather than two fixed parameters: the feed is
 *  gaining a third source (access proposals, §8 of the absorption design),
 *  and a fixed two-argument signature would need a call-site change at every
 *  future source count instead of once here. */
export function mergeEvents(
  sources: readonly (readonly NotificationItem[])[],
  limit: number,
): NotificationItem[] {
  return sources.flat().sort(compareByAtDescending).slice(0, limit);
}

/**
 * Unread is derived, never stored.
 *
 * `null` last-seen means the operator has never opened the panel, and that
 * reads as ZERO rather than as the entire window. The alternative ships a bell
 * with every ticket ever in it on the day it launches, which trains everyone
 * to ignore it.
 *
 * An item with no `at` is excluded from the count outright, for the same
 * reason `compareByAtDescending` sorts it oldest: an undated proposal can
 * never be PROVEN newer than `lastSeenAt`, so counting it as unread would
 * badge an item the operator can never clear by "seeing" it (there is no
 * real timestamp `writeLastSeenAt` could ever record that would exceed an
 * absent one).
 *
 * `lastSeenAt` is ONE watermark per operator, shared across every kind —
 * see `lib/db/notifications-repo.ts`'s doc comment for the accepted
 * consequence (a newly-gained kind's backlog can arrive pre-read).
 */
export function countUnread(
  items: readonly NotificationItem[],
  lastSeenAt: string | null,
): number {
  if (!lastSeenAt) return 0;
  return items.filter((item) => item.at !== undefined && item.at > lastSeenAt).length;
}
