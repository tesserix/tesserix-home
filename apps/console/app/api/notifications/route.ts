import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
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
} from "@/lib/notifications";

/**
 * The bell's endpoint. GET reads the feed, POST marks it seen.
 *
 * Both assert `read`. The middleware matcher already covers /api/*, but a
 * surface that leans on routing for its authorization stops being safe the
 * moment the matcher changes — and this one writes.
 */

// Never cached: the whole point is what changed in the last minute.
export const dynamic = "force-dynamic";

function windowStart(now: Date): string {
  return new Date(
    now.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

async function authorize(): Promise<{ sub: string } | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    // The bell's feed is ticket and reply rows, so it carries support data and
    // gates on the support surface rather than console entry.
    await checkOperatorCapabilityLive(session, "support");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  return { sub: session.sub };
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
    const items = mergeEvents(
      ticketRows.map(toTicketEvent),
      replyRows.map(toReplyEvent),
      FEED_LIMIT,
    );
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
