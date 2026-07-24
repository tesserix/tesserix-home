"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";

type TemplateStatus = "published" | "draft";

interface TemplateRow {
  database: "platform_api" | "marketplace_api";
  key: string;
  subject: string;
  status: TemplateStatus;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface ListResponse {
  database: "platform_api" | "marketplace_api";
  templates: TemplateRow[];
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<TemplateStatus, string> = {
  published: "bg-emerald-50 text-emerald-700",
  draft: "bg-amber-50 text-amber-700",
};

const DB_LABEL: Record<string, string> = {
  platform_api: "platform-api",
  marketplace_api: "marketplace-api",
};

export default function Mark8lyTemplatesListPage() {
  const [database, setDatabase] = useState<"platform_api" | "marketplace_api">(
    "platform_api",
  );
  const { data, isLoading, error } = useSWR<ListResponse>(
    `/api/admin/email-templates?database=${database}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const templates = data?.templates ?? [];

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Mark8ly · Email templates"
        description="Authoring surface for mark8ly's transactional templates. Stored in each mark8ly DB; runtime path uses embedded fallback if a row is missing."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-1.5">
          {(["platform_api", "marketplace_api"] as const).map((db) => (
            <button
              key={db}
              onClick={() => setDatabase(db)}
              aria-pressed={database === db}
              className={
                "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                (database === db
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50")
              }
            >
              {DB_LABEL[db]}
            </button>
          ))}
        </div>

        {error && (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <p className="font-medium">
              Could not load templates from {DB_LABEL[database]}.
            </p>
            <p className="text-xs text-muted-foreground">
              If this is a fresh deploy, mark8ly&apos;s{" "}
              <code className="rounded bg-muted px-1">email_templates</code>{" "}
              migration may not have run yet. Bump the {DB_LABEL[database]}{" "}
              image pin in <code className="rounded bg-muted px-1">tesserix-k8s</code>{" "}
              and ArgoCD-sync, then retry. See the operator activation
              checklist in <code className="rounded bg-muted px-1">.planning/HANDOFF.md</code>.
            </p>
          </div>
        )}
        {!isLoading && !error && templates.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The mark8ly seed migration populates the {DB_LABEL[database]} catalog
              on first boot. If this is empty, the migration may not have run yet.
            </p>
          </div>
        )}

        {templates.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 tabular-nums">Version</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr
                    key={t.key}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        href={`/admin/apps/mark8ly/notifications/templates/${encodeURIComponent(t.key)}?database=${database}`}
                        className="hover:underline"
                      >
                        {t.key}
                      </Link>
                    </td>
                    <td className="max-w-[28rem] px-4 py-3">
                      <span className="block truncate" title={t.subject}>
                        {t.subject}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[t.status]}`}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">v{t.version}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <span title={t.updatedBy ?? ""}>
                        {new Date(t.updatedAt).toLocaleString()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
