// Cross-product user search — Wave 1 sources.
// Session-authed via the global middleware; no extra auth check here.

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

const MIN_QUERY_LENGTH = 3;

interface SourceFailure {
  readonly source: string;
  readonly message: string;
}

interface SearchResponse {
  readonly query: string;
  readonly results: UserSearchResult[];
  readonly failures: SourceFailure[];
  readonly truncated: boolean;
  readonly generatedAt: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("q") ?? "";
  const q = raw.trim().toLowerCase();

  if (q.length < MIN_QUERY_LENGTH) {
    const empty: SearchResponse = {
      query: q,
      results: [],
      failures: [],
      truncated: false,
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(empty);
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

  // Promise.allSettled — one failed source (missing grant, slow DB) MUST
  // NOT take down the whole search. Each failure is reported back so the
  // UI can surface "couldn't reach mark8ly platform DB" without hiding
  // the local results that did come through.
  const settled = await Promise.allSettled(
    sources.map(async (s) => ({ name: s.name, rows: await s.run(q) })),
  );

  const results: UserSearchResult[] = [];
  const failures: SourceFailure[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push(...s.value.rows);
    } else {
      const sourceName = sources[i].name;
      logger.warn(`[users-search] source ${sourceName} failed`, s.reason);
      failures.push({
        source: sourceName,
        message: s.reason instanceof Error ? s.reason.message : "unknown error",
      });
    }
  }

  // Stable sort by source priority (most actionable first), then recency.
  // Order: a person you're looking up is most likely either a tenant owner
  // or one of their customers — both surface immediately. Mark8ly accounts
  // (the platform-wide identity table) are confirmation signal only.
  const sourceRank: Record<string, number> = {
    tenants: 0,
    customers: 1,
    leads: 2,
    mark8ly_users: 3,
    invitations: 4,
    platform_tickets: 5,
    merchant_tickets: 6,
    onboarding: 7,
  };
  results.sort((a, b) => {
    const ra = sourceRank[a.source] ?? 99;
    const rb = sourceRank[b.source] ?? 99;
    if (ra !== rb) return ra - rb;
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  const TOTAL_LIMIT = 100;
  const truncated = results.length > TOTAL_LIMIT;
  const trimmed = truncated ? results.slice(0, TOTAL_LIMIT) : results;

  const body: SearchResponse = {
    query: q,
    results: trimmed,
    failures,
    truncated,
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
