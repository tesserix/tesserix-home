// Cross-product user search — Wave 1 sources.
// Session-authed via the global middleware; no extra auth check here.

import { NextResponse, type NextRequest } from "next/server";
import {
  searchLeads,
  searchPlatformTickets,
  searchMark8lyTenants,
  searchMark8lyInvitations,
  searchMark8lyOnboarding,
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
    { name: "leads", run: searchLeads },
    { name: "invitations", run: searchMark8lyInvitations },
    { name: "onboarding", run: searchMark8lyOnboarding },
    { name: "platform_tickets", run: searchPlatformTickets },
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

  // Stable sort: tenant owners first (most useful), then by recency.
  const sourceRank: Record<string, number> = {
    tenants: 0,
    leads: 1,
    invitations: 2,
    platform_tickets: 3,
    onboarding: 4,
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
