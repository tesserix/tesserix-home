import { NextResponse } from "next/server";
import {
  CapabilityError,
  getCurrentSession,
  type Capability,
} from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
  writeLastSeenAt,
} from "@/lib/db/notifications-repo";
import { fetchMergedProposals, fetchProposals } from "@/lib/secrets-api";
import {
  FEED_LIMIT,
  FEED_WINDOW_DAYS,
  countUnread,
  mergeEvents,
  toMergedProposalEvent,
  toProposalEvent,
  toReplyEvent,
  toTicketEvent,
  type AccessProposalMergedNotification,
  type NotificationItem,
  type NotificationKind,
} from "@/lib/notifications";

/**
 * The bell's endpoint. GET reads the feed, POST marks it seen.
 *
 * Neither asserts a single capability. Entry is console entry — a session is
 * required and nothing more — and each item in the feed is filtered by the
 * capability its OWN kind answers to (see CAPABILITY_FOR_KIND below). The
 * middleware matcher already covers /api/*, but a surface that leans on
 * routing for its authorization stops being safe the moment the matcher
 * changes — and this one writes — so both handlers still fail closed on
 * their own for a missing session.
 */

// Never cached: the whole point is what changed in the last minute.
export const dynamic = "force-dynamic";

/**
 * Which capability admits which kind of notification.
 *
 * The two ticket kinds answer to `support`, as before. The proposal kind
 * answers to `rotate-credentials` — the VERB, not `platform`, the surface
 * that gates the reviews queue page itself. The capability module's own
 * reasoning applies here: the risk verbs are what separate reading the
 * uptime board from rotating a live credential. An operator holding
 * `platform` but not `rotate-credentials` can already open the reviews
 * queue and look, but cannot approve, merge, or reject an entry in it — so
 * telling them one is waiting would be exactly the noise a
 * capability-filtered feed exists to remove: a notification only this map
 * would ever earn a click that goes nowhere.
 *
 * This map states only half of the effective gate. `fetchProposals` calls
 * secrets-api's `/api/reviews` (the `read` group), which requires
 * `platform` on the CALLING operator's own token — a requirement this map
 * says nothing about because it lives in secrets-api, not here. An operator
 * granted `rotate-credentials` without `platform` clears this map's check,
 * then gets a 403 from secrets-api that `safeProposalEvents` swallows to
 * `[]`: their bell is permanently, silently empty of proposals. Benign in
 * outcome (they see nothing, not something wrong), but undiagnosable from
 * this file alone — the real gate is `rotate-credentials` AND `platform`.
 *
 * This caveat does not apply to `access_proposal_merged`: its map value is
 * `platform`, the same capability `secrets-api`'s `/api/reviews/merged`
 * (the `read` group) already requires of the calling operator's own token,
 * so for this kind the map value IS the whole gate.
 */
const CAPABILITY_FOR_KIND: Record<NotificationKind, Capability> = {
  ticket_created: "support",
  merchant_reply: "support",
  access_proposal_open: "rotate-credentials",
  // `platform`, NOT `rotate-credentials`. This kind's recipient is the
  // operator who raised the proposal and could not clear it — by the premise
  // of #506 they hold `platform` and may hold nothing else. Gating their own
  // confirmation behind the verb they lack would make it unreachable by
  // exactly the person it is for.
  access_proposal_merged: "platform",
};

const RELEVANT_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(Object.values(CAPABILITY_FOR_KIND)),
);

/**
 * Fetches open access proposals as notification items, never throwing.
 *
 * The console itself answers 501 (thrown by `secretsRequest` in
 * `lib/secrets-api.ts`, before any network call) when `SECRETS_API_ORIGIN`
 * is unset — `secrets-api` never sees that request and answers nothing.
 * `secrets-api` DOES answer 503 when no review repository is configured
 * (`fetchProposals`'s doc comment in `lib/secrets-api.ts`). Neither is a
 * bug, both are "this leg has nothing to say right now" states. Either one
 * — or a genuine network failure — is caught HERE, at the proposals leg
 * alone, so it can never cost the operator their ticket/reply rows from
 * the same response.
 *
 * This is the opposite call to the one the secret detail page makes for its
 * grants read (`app/(console)/platform/secrets/[...path]/page.tsx`), and
 * deliberately so, not inconsistently: that page's grants list, if defaulted
 * to `[]` on failure, would render "No app can read this" — an ALARM the
 * page would be asserting about the world that might not be true, straight
 * into a security-relevant surface. There is no equivalent false claim
 * available here: an empty (or partial) proposals section says nothing
 * more than "nothing to show you from this source right now," which is
 * true whether the cause is an empty queue or a leg that just failed. A
 * silent notifications feed is a worse outcome than one that always has
 * something to fetch, but neither outcome asserts a fact about the world
 * the way the grants page's empty-list default would.
 *
 * Capped at `FEED_LIMIT`, same reasoning as the `LIMIT` the ticket/reply
 * repo queries already carry: `fetchProposals` is unbounded on this end —
 * it returns every open `grant/*` pull request on the base branch
 * (`secrets-api/internal/gitops/review.go`'s `Pulls`, paginated up to 1000)
 * — so without a cap here this leg alone could hand `route.ts` more than
 * `FEED_LIMIT` items before capability filtering even runs. GitHub already
 * returns them newest-first (`Pulls` sorts by `CreatedAt` descending), so
 * slicing here keeps the newest ones.
 *
 * `PROPOSALS_TIMEOUT_MS` bounds this leg's latency, not just its failure
 * modes: `secretsRequest` (`lib/secrets-api.ts`) passes no `AbortSignal` of
 * its own, so a `secrets-api` that accepts the connection and never answers
 * would otherwise hold this `Promise.all` — and the ticket/reply rows
 * alongside it — open indefinitely. Only `fetchProposals`'s optional
 * `signal` parameter is used here; see its doc comment for why the reviews
 * queue page's call is deliberately left without one.
 */
const PROPOSALS_TIMEOUT_MS = 5_000;

async function safeProposalEvents(): Promise<NotificationItem[]> {
  try {
    const proposals = await fetchProposals(AbortSignal.timeout(PROPOSALS_TIMEOUT_MS));
    return proposals.map(toProposalEvent).slice(0, FEED_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Fetches merged proposals as notification items, never throwing.
 *
 * Same reasoning as `safeProposalEvents`: this leg's failure is "nothing to
 * say right now", and must never cost the ticket rows in the same response.
 *
 * Deliberately NOT sliced to `FEED_LIMIT` here, unlike `safeProposalEvents`.
 * `fetchMergedProposals` returns merges for EVERY operator, not just the
 * caller's — capping this leg before `visibleTo`'s recipient check runs
 * would apply `FEED_LIMIT` to the unfiltered superset, exactly the mistake
 * the comment on `sources` below warns against for `fetchProposals`, except
 * one level deeper: with 20+ merges in the window, an operator whose own
 * merge sorts past index `FEED_LIMIT - 1` would never see it, no matter how
 * recent. The recipient filter in `GET` narrows this list to (at most) the
 * caller's own items before `mergeEvents` applies `FEED_LIMIT` to the
 * merged, already-filtered result — so the cap still holds, just later.
 */
async function safeMergedProposalEvents(since: Date): Promise<NotificationItem[]> {
  try {
    const merged = await fetchMergedProposals(
      since.toISOString(),
      AbortSignal.timeout(PROPOSALS_TIMEOUT_MS),
    );
    return merged
      .map(toMergedProposalEvent)
      .filter((e): e is AccessProposalMergedNotification => e !== undefined);
  } catch {
    return [];
  }
}

function windowStart(now: Date): string {
  return new Date(
    now.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Resolves which of the relevant capabilities this session currently holds.
 *
 * Deliberately N sequential `checkOperatorCapabilityLive` calls rather than
 * one `resolveLiveCapabilities` call followed by N `hasCapability` checks.
 * The cheaper shape bypasses the provider gate and the platform-operator
 * allowlist short-circuit that live inside `checkOperatorCapabilityLive`
 * (`lib/auth/operator.ts` ~130-135) — and BOTH operators on the current
 * allowlist take that short-circuit, so skipping it would change who sees
 * what today, not just in some future edge case. `resolveLiveCapabilities`
 * is not memoised, so this does cost one store resolution per capability;
 * with three capabilities today that is an acceptable price for not
 * re-implementing gate logic that already exists and is already tested.
 */
async function heldCapabilities(
  session: Parameters<typeof checkOperatorCapabilityLive>[0],
): Promise<ReadonlySet<Capability>> {
  const held = new Set<Capability>();
  for (const capability of RELEVANT_CAPABILITIES) {
    try {
      await checkOperatorCapabilityLive(session, capability);
      held.add(capability);
    } catch (cause) {
      if (!(cause instanceof CapabilityError)) throw cause;
    }
  }
  return held;
}

interface Authorized {
  readonly sub: string;
  readonly capabilities: ReadonlySet<Capability>;
}

async function authorize(): Promise<Authorized | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return { sub: session.sub, capabilities: await heldCapabilities(session) };
}

/**
 * Capability admits a KIND; `recipientSub` admits a PERSON. Both must pass.
 *
 * The capability check alone cannot express "yours": every `platform` holder
 * would see every merged proposal, which is one operator reading another's
 * activity. Items with no `recipientSub` are capability-addressed and keep
 * exactly their previous behaviour.
 *
 * Discriminates on `item.kind === "access_proposal_merged"`, not on
 * `"recipientSub" in item`. The two read the same today, but the KIND check
 * is the one that stays correct: `recipientSub` is only optional-shaped
 * because `AccessProposalMergedNotification` declares it required and no
 * other member declares it at all, a fact enforced two files away
 * (`lib/notifications.ts`'s interfaces) rather than here. A future kind
 * that declares an optional `recipientSub` for some other reason would
 * silently start taking the "PERSON" branch under a presence check with no
 * compile error anywhere in this file; matching on the literal kind cannot
 * be perturbed that way, because adding a kind to the union without
 * teaching this function about it is exactly what `CAPABILITY_FOR_KIND`
 * being a `Record<NotificationKind, Capability>` already forces a decision
 * on above.
 */
function visibleTo(
  item: NotificationItem,
  capabilities: ReadonlySet<Capability>,
  sub: string,
): boolean {
  // Fails closed for EVERY kind, not just the recipient-addressed one:
  // `verifySession` only requires `sub` to be a string, not a non-empty one,
  // so a session whose `sub` typechecks as `""` must still see nothing
  // rather than falling through to a capability-only check that would show
  // it every capability-addressed item in the feed.
  if (!sub) return false;
  if (!capabilities.has(CAPABILITY_FOR_KIND[item.kind])) return false;
  return item.kind === "access_proposal_merged" ? item.recipientSub === sub : true;
}

export async function GET(): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    const since = windowStart(new Date());
    // Derived from the same `since` string `recentTicketRows` and
    // `recentMerchantReplyRows` use, rather than a second, independent
    // `now.getTime() - FEED_WINDOW_DAYS * ...` computation — that would
    // desynchronise the merged leg's window from the ticket/reply legs the
    // moment either arithmetic changed without the other.
    const [ticketRows, replyRows, proposalEvents, mergedEvents, lastSeenAt] = await Promise.all([
      recentTicketRows(since, FEED_LIMIT),
      recentMerchantReplyRows(since, FEED_LIMIT),
      safeProposalEvents(),
      safeMergedProposalEvents(new Date(since)),
      readLastSeenAt(auth.sub),
    ]);
    // Filtered BEFORE merging, and merged BEFORE counting.
    //
    // Filtering after `mergeEvents` would let `FEED_LIMIT` apply to the
    // UNFILTERED union of every source, not to what this operator can
    // actually see. The ticket and reply repo queries are each bounded by
    // their own LIMIT, but `fetchProposals()` (via `safeProposalEvents`) can
    // return every open `grant/*` pull request — so 20+ open proposals sort
    // newest-first into every one of `FEED_LIMIT`'s slots, and a
    // `support`-only operator's filter would then remove all of them: their
    // bell reads "nothing waiting" while real, unshown tickets sit past the
    // truncation point. Filtering each source first means `FEED_LIMIT`
    // bounds what the operator can see, the same guarantee the per-source
    // LIMIT already gives the ticket and reply legs.
    //
    // Counting after merging (rather than counting each filtered source on
    // its own) still has to happen last: an operator who cannot see a kind
    // must not have it counted either, or the badge promises items the panel
    // will never show them.
    const sources = [
      ticketRows.map(toTicketEvent),
      replyRows.map(toReplyEvent),
      proposalEvents,
      mergedEvents,
    ].map((source) => source.filter((item) => visibleTo(item, auth.capabilities, auth.sub)));
    const items = mergeEvents(sources, FEED_LIMIT);
    return NextResponse.json({
      items,
      unread: countUnread(items, lastSeenAt),
      lastSeenAt,
    });
  } catch {
    // Deliberately not the driver's message: it carries the connection string
    // and the role name. The operator gets a state, the detail goes nowhere.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const lastSeenAt = new Date().toISOString();
  try {
    await writeLastSeenAt(auth.sub, lastSeenAt);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lastSeenAt });
}
