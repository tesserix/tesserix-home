"use client";

// Leads management page. Lists current leads from /api/admin/leads,
// supports status filter, status edit, and a paste-JSON import drawer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Upload } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";
import { LEAD_STATUSES } from "@/lib/leads/schema";

interface Lead {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  owner: string | null;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
}

interface ImportSummary {
  import_id: string;
  total: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; email?: string; error: string }>;
}

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  ...LEAD_STATUSES.map((s) => ({ value: s, label: s })),
];

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url =
        filter === "all" ? "/api/admin/leads" : `/api/admin/leads?status=${filter}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { leads: Lead[] };
      setLeads(data.leads);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateStatus = useCallback(
    async (id: string, status: string) => {
      const res = await fetch(`/api/admin/leads/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        await refresh();
      }
    },
    [refresh],
  );

  const totalsByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of LEAD_STATUSES) m[s] = 0;
    for (const l of leads) m[l.status] = (m[l.status] ?? 0) + 1;
    return m;
  }, [leads]);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Leads" />
      <div className="flex-1 space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={
                  "rounded-full border px-3 py-1 text-xs capitalize transition-colors " +
                  (filter === f.value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground/40")
                }
              >
                {f.label}
                {f.value !== "all" && totalsByStatus[f.value] > 0 ? (
                  <span className="ml-1 opacity-70">{totalsByStatus[f.value]}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40"
            >
              <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setImportOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:bg-foreground/90"
            >
              <Upload className="h-3 w-3" />
              Import
            </button>
          </div>
        </div>

        {importOpen ? (
          <ImportDrawer
            onClose={() => setImportOpen(false)}
            onComplete={() => {
              setImportOpen(false);
              void refresh();
            }}
          />
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Error: {error}
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No leads. Click <span className="font-medium">Import</span> to add some.
                  </td>
                </tr>
              ) : (
                leads.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{l.email}</td>
                    <td className="px-4 py-3">{l.name ?? "—"}</td>
                    <td className="px-4 py-3">{l.company ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{l.source ?? "—"}</td>
                    <td className="px-4 py-3">
                      <select
                        value={l.status}
                        onChange={(e) => void updateStatus(l.id, e.target.value)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs capitalize"
                      >
                        {LEAD_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(l.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface ImportDrawerProps {
  onClose: () => void;
  onComplete: () => void;
}

function ImportDrawer({ onClose, onComplete }: ImportDrawerProps) {
  const [pasted, setPasted] = useState<string>("");
  const [source, setSource] = useState<string>("manual-paste");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const rows = parseRows(pasted);
      const res = await fetch("/api/admin/leads/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, rows }),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ImportSummary;
      setSummary(data);
      if (data.failed === 0) {
        // Brief delay so user sees the result, then close.
        setTimeout(onComplete, 800);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-medium">Import leads</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        Paste CSV (one row per line, header = <code className="font-mono">email,name,company,source,status,notes,owner</code>) OR JSON array of objects.
      </p>
      <div className="grid gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="src">
            Source label
          </label>
          <input
            id="src"
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            placeholder="manual-paste / typeform-2026-04 / …"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rows">
            Rows
          </label>
          <textarea
            id="rows"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
            placeholder='email,name,company\nfoo@x.com,Foo,Acme'
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !pasted.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            {submitting ? "Importing…" : "Import"}
          </button>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
        {summary ? (
          <div className="rounded-md border border-border bg-background p-3 text-xs">
            <div>
              {summary.total} processed · {summary.inserted} new · {summary.updated} updated · {summary.failed} failed
            </div>
            {summary.failed > 0 ? (
              <ul className="mt-2 space-y-1 text-destructive">
                {summary.errors.slice(0, 10).map((e) => (
                  <li key={e.row}>
                    row {e.row + 1} ({e.email ?? "?"}): {e.error}
                  </li>
                ))}
                {summary.errors.length > 10 ? (
                  <li>+{summary.errors.length - 10} more</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface ParsedRow {
  email: string;
  name?: string;
  company?: string;
  source?: string;
  status?: string;
  notes?: string;
  owner?: string;
}

// Parse pasted text — JSON array first, fall back to CSV.
function parseRows(input: string): ParsedRow[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // JSON array path.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as ParsedRow[];
    if (!Array.isArray(parsed)) {
      throw new Error("expected JSON array of objects");
    }
    return parsed;
  }

  // CSV path. Header is the first non-empty line.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV needs a header row + at least one data row");
  }
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, j) => {
      const v = (cells[j] ?? "").trim();
      if (v.length > 0) row[h] = v;
    });
    if (!row.email) {
      throw new Error(`row ${i + 1} missing email`);
    }
    out.push(row as unknown as ParsedRow);
  }
  return out;
}

// Minimal CSV splitter that handles quoted fields.
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}
