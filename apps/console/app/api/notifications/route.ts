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
import { fetchProposals } from "@/lib/secrets-api";
import {
  FEED_LIMIT,
  FEED_WINDOW_DAYS,
  countUnread,
  mergeEvents,
  toProposalEvent,
  toReplyEvent,
  toTicketEvent,
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
 */
const CAPABILITY_FOR_KIND: Record<NotificationKind, Capability> = {
  ticket_created: "support",
  merchant_reply: "support",
  access_proposal_open: "rotate-credentials",
};

const RELEVANT_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(Object.values(CAPABILITY_FOR_KIND)),
);

/**
 * Fetches open access proposals as notification items, never throwing.
 *
 * `secrets-api` answers 501 when `SECRETS_API_ORIGIN` is unset (not
 * deployed yet) and 503 when no review repository is configured
 * (`fetchProposals`'s doc comment in `lib/secrets-api.ts`) — neither is a
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
 */
async function safeProposalEvents(): Promise<NotificationItem[]> {
  try {
    const proposals = await fetchProposals();
    return proposals.map(toProposalEvent);
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
 * with two capabilities today that is an acceptable price for not
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

function visibleTo(
  item: NotificationItem,
  capabilities: ReadonlySet<Capability>,
): boolean {
  return capabilities.has(CAPABILITY_FOR_KIND[item.kind]);
}

export async function GET(): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    const since = windowStart(new Date());
    const [ticketRows, replyRows, proposalEvents, lastSeenAt] = await Promise.all([
      recentTicketRows(since, FEED_LIMIT),
      recentMerchantReplyRows(since, FEED_LIMIT),
      safeProposalEvents(),
      readLastSeenAt(auth.sub),
    ]);
    const merged = mergeEvents(
      [ticketRows.map(toTicketEvent), replyRows.map(toReplyEvent), proposalEvents],
      FEED_LIMIT,
    );
    // Filtered BEFORE counting: an operator who cannot see a kind must not
    // have it counted either, or the badge promises items the panel will
    // never show them.
    const items = merged.filter((item) => visibleTo(item, auth.capabilities));
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
