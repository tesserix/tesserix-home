"use client";

// Apps registry — products this super-admin oversees. Sourced from
// tesserix-postgres.tesserix_admin.apps. Read-only Phase 1 (new product
// onboarding is a runbook step in tesserix-k8s/docs/cross-db-admin.md).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";

interface AppEntry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "planned" | "archived" | "deprecated";
  db_namespace: string | null;
  db_databases: string[] | null;
  primary_domain: string | null;
  admin_url: string | null;
}

export default function AppsPage() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/apps", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { apps: AppEntry[] };
        if (!cancelled) setApps(data.apps);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Apps" />
      <div className="flex-1 space-y-4 p-6">
        <p className="text-sm text-muted-foreground">
          Products this super-admin oversees. To add a new product, follow the cross-DB admin runbook in tesserix-k8s.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" /> Loading
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Error: {error}
          </div>
        ) : apps.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            No apps registered.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {apps.map((a) => (
              <article key={a.id} className="rounded-lg border border-border bg-card p-5">
                <header className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-medium">{a.name}</h3>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs capitalize " +
                          (a.status === "active"
                            ? "bg-emerald-500/15 text-emerald-700"
                            : a.status === "planned"
                            ? "bg-blue-500/15 text-blue-700"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {a.status}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">{a.slug}</p>
                  </div>
                  {a.admin_url ? (
                    <Link
                      href={a.admin_url.replace("{slug}", a.slug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : null}
                </header>
                {a.description ? (
                  <p className="mt-3 text-sm text-muted-foreground">{a.description}</p>
                ) : null}
                <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Namespace</dt>
                    <dd className="mt-0.5 font-mono">{a.db_namespace ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Domain</dt>
                    <dd className="mt-0.5 font-mono">{a.primary_domain ?? "—"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Databases</dt>
                    <dd className="mt-0.5 font-mono">
                      {a.db_databases && a.db_databases.length > 0
                        ? a.db_databases.join(", ")
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
