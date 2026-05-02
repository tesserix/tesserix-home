"use client";

import Link from "next/link";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";

interface LeadTemplate {
  key: string;
  label: string;
  subject: string;
  status: "published" | "draft";
  product: string;
  version: number;
  updatedAt: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<string, string> = {
  published: "bg-emerald-50 text-emerald-700",
  draft: "bg-amber-50 text-amber-700",
};

export default function LeadTemplatesListPage() {
  const { data, isLoading, error } = useSWR<{ templates: LeadTemplate[] }>(
    "/api/admin/lead-templates",
    fetcher,
    { revalidateOnFocus: false },
  );
  const templates = data?.templates ?? [];

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Lead templates"
        description="Marketing + lead-invite templates owned by tesserix-home. Sent directly to leads via SendGrid (no product hop)."
      />
      <div className="flex-1 space-y-4 p-6">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load templates.
          </div>
        )}
        {!isLoading && templates.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No lead templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a template by saving one with PUT
              /api/admin/lead-templates/&lt;key&gt;. A list/create UI lands once
              the first template ships — for now, edit existing ones via this
              list.
            </p>
          </div>
        )}

        {templates.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Product</th>
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
                        href={`/admin/notifications/lead-templates/${encodeURIComponent(t.key)}`}
                        className="hover:underline"
                      >
                        {t.key}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{t.label}</td>
                    <td className="max-w-[24rem] px-4 py-3">
                      <span className="block truncate" title={t.subject}>
                        {t.subject}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {t.product || "any"}
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
                      {new Date(t.updatedAt).toLocaleString()}
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
