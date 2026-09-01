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
import {
  FEED_LIMIT,
  FEED_WINDOW_DAYS,
  countUnread,
  mergeEvents,
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
 * Both current kinds are ticket and reply rows, so both still answer to
 * `support` — that reasoning doesn't change. What changes is that it is no
 * longer the gate for the whole feed: a later kind (an access proposal
 * awaiting approval, §8 of the absorption design) answers to
 * `rotate-credentials` instead, and this map is what lets the two coexist
 * without either one leaking to an operator who can't act on it.
 */
const CAPABILITY_FOR_KIND: Record<NotificationKind, Capability> = {
  ticket_created: "support",
  merchant_reply: "support",
};

const RELEVANT_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(Object.values(CAPABILITY_FOR_KIND)),
);

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
    const [ticketRows, replyRows, lastSeenAt] = await Promise.all([
      recentTicketRows(since, FEED_LIMIT),
      recentMerchantReplyRows(since, FEED_LIMIT),
      readLastSeenAt(auth.sub),
    ]);
    const merged = mergeEvents(
      [ticketRows.map(toTicketEvent), replyRows.map(toReplyEvent)],
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
