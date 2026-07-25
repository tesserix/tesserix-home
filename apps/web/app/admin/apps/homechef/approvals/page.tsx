"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { AlertTriangle, BellRing, CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, formatRelative, titleCase, type ApprovalPriority, type ApprovalRequest, type ApprovalStatus, type Paginated } from "@tesserix/homechef-shared";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";

const STATUSES: { key: ApprovalStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "info_requested", label: "Info requested" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

// #697 — the escalated/reminded panels are TABS here rather than their own pages.
// It is the same queue, filtered; a separate route would duplicate the table, the
// fetch and the Review link, and would drift.
type Tab = ApprovalStatus | "reminded" | "escalated";

const REMINDED: Tab = "reminded";
const ESCALATED: Tab = "escalated";

// A row's escalation level is a pure function of how many times the submitter has
// chased it. Colour tracks urgency: nudged (amber) → chased twice (purple) →
// escalated (red, with a bell). Kept as one helper so the stripe, the row tint and
// the chip all read off the same level and can never disagree.
type ReminderTone = "none" | "amber" | "purple" | "red";

function reminderLevel(reminderCount: number | null | undefined): {
  tone: ReminderTone;
  showBell: boolean;
} {
  const n = reminderCount ?? 0;
  if (n >= 3) return { tone: "red", showBell: true };
  if (n === 2) return { tone: "purple", showBell: false };
  if (n === 1) return { tone: "amber", showBell: false };
  return { tone: "none", showBell: false };
}

// Row background tint, keyed off the level. Neutral rows keep the table default hover.
const rowToneClasses: Record<ReminderTone, string> = {
  none: "hover:bg-muted/30",
  amber: "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30",
  purple: "bg-purple-50/60 hover:bg-purple-50 dark:bg-purple-950/20 dark:hover:bg-purple-950/30",
  red: "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30",
};

// Left accent stripe on the first cell of the row, same level key.
const accentClasses: Record<ReminderTone, string> = {
  none: "",
  amber: "border-l-4 border-amber-400 dark:border-amber-500",
  purple: "border-l-4 border-purple-400 dark:border-purple-500",
  red: "border-l-4 border-red-500",
};

// Chip tone. StatusBadge only ships neutral/success/warning/danger/info tones (no
// purple), so the reminder chip carries its own classes but mirrors StatusBadge's
// shape for visual consistency.
const chipBase =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap";
const chipToneClasses: Record<Exclude<ReminderTone, "none">, string> = {
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

// How long a request has been waiting, phrased for triage.
function waitedFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  return `${Math.max(hrs, 0)}h`;
}

function priorityTone(p: ApprovalPriority): Tone {
  if (p === "urgent") return "danger";
  if (p === "high") return "warning";
  if (p === "low") return "neutral";
  return "info";
}

function HomechefApprovalsInner() {
  const [tab, setTab] = useState<Tab>("pending");
  // Deep-linked from the chefs page (?search=<businessName>) — seed the box from
  // the URL on mount, then it is a normal controlled input.
  const initialSearch = useSearchParams().get("search") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const remindedView = tab === REMINDED;
  const escalatedView = tab === ESCALATED;

  // Reminded/escalated are deliberately NOT status-filtered: a chef chases a
  // request whatever state it is in, and hiding a chased info_requested item behind
  // a status tab is how it would go quiet again. The API sorts these to the top and
  // accepts reminded=true / escalated=true, so we just swap the param. Search
  // (title/description ILIKE, server-side) layers on top of any view.
  const trimmedSearch = search.trim();
  const listParams = escalatedView
    ? { escalated: "true", search: trimmedSearch, page: 1, limit: 50 }
    : remindedView
      ? { reminded: "true", search: trimmedSearch, page: 1, limit: 50 }
      : { status: tab, search: trimmedSearch, page: 1, limit: 50 };
  const { data, isLoading, mutate } = useSWR<Paginated<ApprovalRequest>>(
    ["/approvals", listParams],
    swrFetcher,
  );
  const items = data?.data ?? [];

  // Bulk approve — the admin's "Approve selected" on the queue. Only offered on views that hold
  // approvable rows (pending / info_requested, plus the reminded/escalated cross-cuts which are
  // mostly those states). Approved/rejected tabs show no checkboxes.
  const canBulk = tab === "pending" || tab === "info_requested" || remindedView || escalatedView;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  // Drop any selection when the view changes — the visible rows change with it.
  useEffect(() => setSelected(new Set()), [tab]);

  const visibleIds = items.map((a) => a.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  }

  async function approveSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Approve ${ids.length} request${ids.length === 1 ? "" : "s"}? This is the same as approving each one — menu items become visible, chefs/drivers get verified.`)) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await hcAdmin.post<{ approved: number; failed: number; failures: { id: string; error: string }[] }>(
        "/approvals/bulk-approve",
        { ids },
      );
      setSelected(new Set());
      await mutate();
      if (res.failed > 0) {
        window.alert(`Approved ${res.approved}. ${res.failed} could not be approved (e.g. already decided).`);
      }
    } catch (e) {
      window.alert(`Bulk approve failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Badge the tab so an escalation is visible without opening it. Cheap: the
  // count comes back with the list.
  const { data: escalatedData } = useSWR<Paginated<ApprovalRequest>>(
    ["/approvals", { escalated: "true", page: 1, limit: 1 }],
    swrFetcher,
  );
  const escalatedCount = escalatedData?.pagination.total ?? 0;

  return (
    // pb-28 keeps the last row's "Review" link clear of the fixed
    // "Chat with support" widget that floats over the bottom-right corner.
    <div className="space-y-6 p-6 pb-28">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          {escalatedView
            ? "Chefs have chased these repeatedly — we have been slow, not them"
            : remindedView
              ? "Chefs have nudged these at least once — clear them before they escalate"
              : data
                ? `${data.pagination.total} ${titleCase(tab)}`
                : "Review queue"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title or description…"
          className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm"
        />
        {search ? (
          <button
            onClick={() => setSearch("")}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setTab(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === s.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s.label}
          </button>
        ))}
        {/* Reminded and Escalated sit apart from the status tabs: they filter the
            queue by how hard the submitter is chasing, not by review state. */}
        <button
          onClick={() => setTab(REMINDED)}
          className={`ml-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
            remindedView
              ? "bg-amber-500 text-white"
              : "bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300"
          }`}
        >
          <BellRing className="h-3.5 w-3.5" aria-hidden />
          Reminded
        </button>
        {/* Escalated carries a count: it is the one tab that means somebody is
            waiting on us. */}
        <button
          onClick={() => setTab(ESCALATED)}
          className={`ml-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
            escalatedView
              ? "bg-red-600 text-white"
              : escalatedCount > 0
                ? "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-300"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Escalated
          {escalatedCount > 0 ? (
            <span
              className={`rounded-full px-1.5 text-xs font-semibold ${
                escalatedView ? "bg-white/20" : "bg-red-600 text-white"
              }`}
            >
              {escalatedCount}
            </span>
          ) : null}
        </button>
      </div>

      {/* Bulk action bar — appears once rows are selected. Sticky-feeling inline bar so the admin
          can clear 24 pending items in one click instead of opening each. */}
      {canBulk && selected.size > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-2.5">
          <span className="text-sm text-foreground">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
            <button
              onClick={() => void approveSelected()}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Approve selected ({selected.size})
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              {canBulk ? (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                    className="h-4 w-4 cursor-pointer accent-foreground"
                  />
                </th>
              ) : null}
              <th className="px-4 py-3">Request</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Chased</th>
              <th className="px-4 py-3">Submitted</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={canBulk ? 7 : 6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={canBulk ? 7 : 6} className="px-4 py-10 text-center text-muted-foreground">
                  {escalatedView ? "Nothing escalated — nobody is waiting on us." : "Nothing in this state."}
                </td>
              </tr>
            ) : (
              items.map((a) => {
                const level = reminderLevel(a.reminderCount);
                const escalated = level.tone === "red" || Boolean(a.escalatedAt);
                const chipTone = level.tone === "none" ? null : level.tone;
                return (
                  <tr key={a.id} className={rowToneClasses[level.tone]}>
                    {canBulk ? (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(a.id)}
                          onChange={() => toggleOne(a.id)}
                          aria-label={`Select ${a.title || a.type}`}
                          className="h-4 w-4 cursor-pointer accent-foreground"
                        />
                      </td>
                    ) : null}
                    <td className={cn("px-4 py-3", accentClasses[level.tone])}>
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        {level.showBell ? (
                          <BellRing
                            className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                            aria-label={`Escalated — reminded ${a.reminderCount ?? 0} times`}
                          />
                        ) : null}
                        {a.title || titleCase(a.type)}
                      </div>
                      {a.kitchenName || a.requestedByName ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {[a.kitchenName, a.requestedByName].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{titleCase(a.type)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={titleCase(a.priority)} tone={priorityTone(a.priority)} />
                    </td>
                    <td className="px-4 py-3">
                      {chipTone ? (
                        <div className="flex flex-col gap-1">
                          <span className={cn(chipBase, chipToneClasses[chipTone])}>
                            {escalated ? "Escalated" : `Reminded ×${a.reminderCount}`}
                            {a.lastRemindedAt ? ` · ${formatRelative(a.lastRemindedAt)}` : ""}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            waiting {waitedFor(a.createdAt)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(a.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/apps/homechef/approvals/${a.id}`}
                        className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function HomechefApprovalsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
      <HomechefApprovalsInner />
    </Suspense>
  );
}
