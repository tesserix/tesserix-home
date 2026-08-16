import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { searchTicketRows } from "@/lib/db/search-repo";
import { MIN_TICKET_QUERY, ticketEntry } from "@/lib/search";

/**
 * The command palette's server-side ticket search.
 *
 * Mirrors apps/console/app/api/notifications/route.ts's authorize/501/500
 * shape: asserts `read` itself rather than leaning on the middleware
 * matcher, answers 501 when tesserix-postgres isn't wired up, and never
 * surfaces the driver's error message on failure.
 */

// Never cached: results must reflect the current ticket queue.
export const dynamic = "force-dynamic";

// The palette shows tickets alongside routes and tools; a long tail of
// matches would push those off screen.
const RESULT_LIMIT = 10;

async function authorize(): Promise<{ sub: string } | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    checkOperatorCapability(session, "read");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  return { sub: session.sub };
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < MIN_TICKET_QUERY) {
    return NextResponse.json({ error: "query_too_short" }, { status: 400 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    const rows = await searchTicketRows(query, RESULT_LIMIT);
    return NextResponse.json({ items: rows.map(ticketEntry) });
  } catch {
    // Deliberately not the driver's message: it carries the connection string
    // and the role name. The operator gets a state, the detail goes nowhere.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
