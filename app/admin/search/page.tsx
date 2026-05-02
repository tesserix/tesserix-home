"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Input } from "@tesserix/web";
import { Search, Loader2, AlertCircle } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";

interface UserSearchResult {
  source: string;
  kind: string;
  email: string;
  label: string;
  sublabel?: string;
  href: string;
  matchedField: string;
  updatedAt: string | null;
}

interface SearchResponse {
  query: string;
  results: UserSearchResult[];
  failures: { source: string; message: string }[];
  truncated: boolean;
}

const MIN_QUERY_LENGTH = 3;

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const SOURCE_TONE: Record<string, string> = {
  tenants: "bg-emerald-500/15 text-emerald-700",
  leads: "bg-sky-500/15 text-sky-700",
  invitations: "bg-amber-500/15 text-amber-700",
  platform_tickets: "bg-violet-500/15 text-violet-700",
  onboarding: "bg-muted text-muted-foreground",
};

const SOURCE_LABEL: Record<string, string> = {
  tenants: "Tenant owners",
  leads: "Leads",
  invitations: "Pending invites",
  platform_tickets: "Platform tickets",
  onboarding: "Onboarding sessions",
};

export default function CrossProductSearchPage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // 250ms debounce so we don't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const valid = debounced.length >= MIN_QUERY_LENGTH;
  const swrKey = valid
    ? `/api/admin/users/search?q=${encodeURIComponent(debounced)}`
    : null;
  const { data, error, isLoading } = useSWR<SearchResponse>(swrKey, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const grouped = useMemo(() => groupBySource(data?.results ?? []), [data]);
  const totalCount = data?.results.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Cross-product search" />
      <div className="flex-1 space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Find a user across leads, tenants, invitations, platform tickets,
            and onboarding sessions. Email substring match — minimum{" "}
            {MIN_QUERY_LENGTH} characters.
          </p>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="acme@example.com"
              aria-label="Search users by email"
              className="pl-9"
              autoFocus
            />
            {isLoading && valid && (
              <Loader2
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Search failed. Try again.</span>
          </div>
        )}

        {data && data.failures.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="font-medium text-amber-700">
                Some sources didn&apos;t respond
              </p>
              <p className="text-xs text-muted-foreground">
                Showing partial results.{" "}
                {data.failures.map((f) => f.source).join(", ")} unavailable.
              </p>
            </div>
          </div>
        )}

        {!valid && query.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Type at least {MIN_QUERY_LENGTH} characters to search.
          </p>
        )}

        {valid && data && totalCount === 0 && !isLoading && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No matches</p>
            <p className="mt-1 text-xs text-muted-foreground">
              No user found with email containing &ldquo;{debounced}&rdquo;.
            </p>
          </div>
        )}

        {valid && totalCount > 0 && (
          <div className="space-y-6">
            <p className="text-xs text-muted-foreground">
              {totalCount} {totalCount === 1 ? "match" : "matches"}
              {data?.truncated ? " (truncated to 100; refine your query)" : ""}
            </p>
            {Array.from(grouped.entries()).map(([source, rows]) => (
              <SourceGroup
                key={source}
                source={source}
                rows={rows}
                query={debounced}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceGroup({
  source,
  rows,
  query,
}: {
  source: string;
  rows: UserSearchResult[];
  query: string;
}) {
  return (
    <section className="space-y-2">
      <header className="flex items-center justify-between border-b border-border pb-1">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          {SOURCE_LABEL[source] ?? source}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </header>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {rows.map((r, i) => (
          <li key={`${r.source}-${i}`}>
            <Link
              href={r.href}
              className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${SOURCE_TONE[r.source] ?? "bg-muted"}`}
                  >
                    {r.kind}
                  </span>
                  <p className="truncate text-sm font-medium">{r.label}</p>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {highlight(r.email, query)}
                  {r.sublabel ? <span> · {r.sublabel}</span> : null}
                </p>
              </div>
              <span
                className="shrink-0 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function groupBySource(rows: UserSearchResult[]): Map<string, UserSearchResult[]> {
  const out = new Map<string, UserSearchResult[]>();
  for (const r of rows) {
    const list = out.get(r.source);
    if (list) list.push(r);
    else out.set(r.source, [r]);
  }
  return out;
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-foreground">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}
