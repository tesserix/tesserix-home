"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Button } from "@tesserix/web";
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

// Slug-style: lowercase letters, digits, underscores. Single regex check
// so the operator can't accidentally create a key with spaces or special
// chars that would later be a pain in URLs / SQL / variable names.
const KEY_PATTERN = /^[a-z0-9_]{3,64}$/;

export default function LeadTemplatesListPage() {
  const router = useRouter();
  const { data, isLoading, error } = useSWR<{ templates: LeadTemplate[] }>(
    "/api/admin/lead-templates",
    fetcher,
    { revalidateOnFocus: false },
  );
  const templates = data?.templates ?? [];

  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);

  function startNew() {
    setNewKey("");
    setNewKeyError(null);
    setShowNew(true);
  }

  function submitNew() {
    const trimmed = newKey.trim().toLowerCase();
    if (!KEY_PATTERN.test(trimmed)) {
      setNewKeyError(
        "Key must be 3–64 characters: lowercase letters, digits, underscores only.",
      );
      return;
    }
    if (templates.some((t) => t.key === trimmed)) {
      setNewKeyError(`A template with key '${trimmed}' already exists.`);
      return;
    }
    router.push(
      `/admin/notifications/lead-templates/${encodeURIComponent(trimmed)}`,
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Lead templates"
        description="Marketing + lead-invite templates owned by tesserix-home. Sent directly to leads via SendGrid (no product hop)."
      />
      <div className="flex-1 space-y-4 p-6">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {templates.length} template{templates.length === 1 ? "" : "s"}
          </p>
          <Button onClick={startNew} variant="outline" size="sm">
            + New template
          </Button>
        </div>

        {showNew && (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              New template
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Pick a slug-style key (e.g. <code>lead_q4_promo</code>). The next
              screen lets you author label, subject, html, and text. The
              template stays in <strong>draft</strong> until you flip it to
              published.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <input
                type="text"
                value={newKey}
                onChange={(e) => {
                  setNewKey(e.target.value);
                  setNewKeyError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNew();
                  if (e.key === "Escape") setShowNew(false);
                }}
                placeholder="lead_q4_promo"
                autoFocus
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <div className="flex gap-2">
                <Button onClick={submitNew}>Continue →</Button>
                <Button onClick={() => setShowNew(false)} variant="outline">
                  Cancel
                </Button>
              </div>
            </div>
            {newKeyError && (
              <p className="mt-2 text-xs text-destructive">{newKeyError}</p>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load templates.
          </div>
        )}
        {!isLoading && templates.length === 0 && !showNew && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No lead templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Click <strong>+ New template</strong> above to author your first
              one. Or apply migration{" "}
              <code className="rounded bg-muted px-1">0006_seed_lead_templates.sql</code>{" "}
              to start with three pre-written templates (welcome / demo invite /
              follow-up).
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
