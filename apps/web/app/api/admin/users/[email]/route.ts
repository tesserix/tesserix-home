// F1 Wave 3 — correlated user detail. Aggregates all 8 search sources
// for a single email into one response. Reuses the same helpers as the
// list-search endpoint so the rules stay in lockstep.

import { NextResponse, type NextRequest } from "next/server";
import {
  searchLeads,
  searchPlatformTickets,
  searchMark8lyTenants,
  searchMark8lyInvitations,
  searchMark8lyOnboarding,
  searchMark8lyCustomers,
  searchMark8lyUsers,
  searchMark8lyMerchantTickets,
  type UserSearchResult,
} from "@/lib/db/users-search";
import { logger } from "@/lib/logger";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ email: string }> },
) {
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail).trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "missing_email" }, { status: 400 });
  }

  const sources: ReadonlyArray<{
    name: string;
    run: (q: string) => Promise<UserSearchResult[]>;
  }> = [
    { name: "tenants", run: searchMark8lyTenants },
    { name: "customers", run: searchMark8lyCustomers },
    { name: "leads", run: searchLeads },
    { name: "mark8ly_users", run: searchMark8lyUsers },
    { name: "invitations", run: searchMark8lyInvitations },
    { name: "platform_tickets", run: searchPlatformTickets },
    { name: "merchant_tickets", run: searchMark8lyMerchantTickets },
    { name: "onboarding", run: searchMark8lyOnboarding },
  ];

  const settled = await Promise.allSettled(
    sources.map(async (s) => ({ name: s.name, rows: await s.run(email) })),
  );

  const grouped: Record<string, UserSearchResult[]> = {};
  const failures: { source: string; message: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const sourceName = sources[i].name;
    if (s.status === "fulfilled") {
      // Detail-page strict matching: substring search may have caught
      // names/companies that aren't actually this email. Filter the
      // returned rows down to those whose email column equals the
      // requested email exactly. Some sources (leads, tenants) might
      // not have email on the row when the match was on name — keep
      // those if they reference any matching email.
      const hits = s.value.rows.filter(
        (r) => r.email && r.email.toLowerCase() === email,
      );
      if (hits.length > 0) grouped[sourceName] = hits;
    } else {
      logger.warn(`[user-detail] source ${sourceName} failed`, s.reason);
      failures.push({
        source: sourceName,
        message: s.reason instanceof Error ? s.reason.message : "unknown error",
      });
    }
  }

  return NextResponse.json({
    email,
    grouped,
    failures,
    totalMatches: Object.values(grouped).reduce((s, rs) => s + rs.length, 0),
    generatedAt: new Date().toISOString(),
  });
}
