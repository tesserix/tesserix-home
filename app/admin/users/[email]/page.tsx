"use client";

import Link from "next/link";
import { use } from "react";
import useSWR from "swr";
import { ChevronLeft } from "lucide-react";
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

interface UserDetailResponse {
  email: string;
  grouped: Record<string, UserSearchResult[]>;
  failures: { source: string; message: string }[];
  totalMatches: number;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const SOURCE_LABEL: Record<string, string> = {
  tenants: "Tenants",
  customers: "Storefront customers",
  leads: "Leads",
  mark8ly_users: "Mark8ly accounts",
  invitations: "Pending invites",
  platform_tickets: "Platform tickets",
  merchant_tickets: "Customer tickets",
  onboarding: "Onboarding sessions",
};

const SOURCE_TONE: Record<string, string> = {
  tenants: "bg-emerald-500/15 text-emerald-700",
  customers: "bg-teal-500/15 text-teal-700",
  leads: "bg-sky-500/15 text-sky-700",
  mark8ly_users: "bg-slate-500/15 text-slate-700",
  invitations: "bg-amber-500/15 text-amber-700",
  platform_tickets: "bg-violet-500/15 text-violet-700",
  merchant_tickets: "bg-fuchsia-500/15 text-fuchsia-700",
  onboarding: "bg-muted text-muted-foreground",
};

const ORDER = [
  "tenants",
  "customers",
  "leads",
  "mark8ly_users",
  "invitations",
  "platform_tickets",
  "merchant_tickets",
  "onboarding",
];

export default function UserDetailPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const { email: rawEmail } = use(params);
  const email = decodeURIComponent(rawEmail);
  const { data, error, isLoading } = useSWR<UserDetailResponse>(
    `/api/admin/users/${encodeURIComponent(email)}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const sourcesPresent = data
    ? ORDER.filter((s) => data.grouped[s]?.length)
    : [];

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title={email} description="Cross-product identity profile" />
      <div className="flex-1 space-y-6 p-6">
        <div>
          <Link
            href="/admin/search"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            Back to search
          </Link>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load this profile.
          </div>
        )}

        {data && data.failures.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700">
            Partial — {data.failures.map((f) => f.source).join(", ")} unavailable.
          </div>
        )}

        {data && data.totalMatches === 0 && !isLoading && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No exact-match identities</p>
            <p className="mt-1 text-xs text-muted-foreground">
              No source has an email row equal to <code>{email}</code>.
            </p>
          </div>
        )}

        {data && data.totalMatches > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {sourcesPresent.map((s) => (
                <span
                  key={s}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${SOURCE_TONE[s] ?? "bg-muted"}`}
                >
                  {SOURCE_LABEL[s] ?? s} · {data.grouped[s].length}
                </span>
              ))}
            </div>

            <div className="space-y-6">
              {sourcesPresent.map((source) => (
                <section key={source} className="space-y-2">
                  <header className="flex items-center justify-between border-b border-border pb-1">
                    <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
                      {SOURCE_LABEL[source] ?? source}
                    </h2>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {data.grouped[source].length}
                    </span>
                  </header>
                  <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                    {data.grouped[source].map((r, i) => (
                      <li key={`${source}-${i}`}>
                        <Link
                          href={r.href}
                          className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/30"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {r.label}
                            </p>
                            {r.sublabel && (
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {r.sublabel}
                              </p>
                            )}
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
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
