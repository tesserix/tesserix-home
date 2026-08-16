"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge, StatusBadge } from "@tesserix/web";
import { SurfaceStateView, type SurfaceState } from "./states";

export type QueueSeverity = "normal" | "warning" | "critical";

/**
 * The kit's own tone vocabulary rather than a re-export of `@tesserix/web`'s
 * `StatusType`: callers construct these values in server components, which
 * cannot import from a client module. Same five names, owned here.
 */
export type QueueStatusTone = "neutral" | "info" | "success" | "warning" | "error";

/**
 * Where a queued item currently sits in its own workflow — open, in progress,
 * resolved. Distinct from `severity`, which is derived from priority and says
 * how loudly the item is shouting. A row wants both: an urgent ticket that is
 * already in progress reads very differently from an urgent one nobody has
 * touched, and collapsing them into one badge loses exactly that.
 */
export interface QueueStatus {
  label: string;
  /** Defaults to `neutral` — a status with no agreed colour is not an alarm. */
  tone?: QueueStatusTone;
}

export interface QueueItem {
  /**
   * Opaque identity for the row. Real queues are keyed compositely —
   * `(aggType, id)`, `(run_id, gate_name)` — so this is never validated or
   * typed as a UUID; it is only ever compared and used as a React key.
   */
  key: string;
  title: string;
  subtitle?: string;
  product: string;
  /** ISO-8601 instant the item entered the queue. */
  waitingSince: string;
  /** ISO-8601 SLA deadline, when the queue has one. */
  dueAt?: string;
  severity: QueueSeverity;
  /**
   * Optional: queues whose items have no workflow state (an approval gate is
   * either waiting or gone) simply omit it, and every caller that predates the
   * slot compiles unchanged.
   */
  status?: QueueStatus;
  href: string;
  actions?: ReactNode;
}

const SEVERITY_STATUS = {
  normal: "neutral",
  warning: "warning",
  critical: "error",
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse, human-readable duration — queues care about "3h", not "3h 12m 4s". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MINUTE))}m`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h`;
  return `${Math.round(abs / DAY)}d`;
}

interface SlaProps {
  dueAt: string;
  now: number;
}

function SlaIndicator({ dueAt, now }: SlaProps) {
  const remaining = new Date(dueAt).getTime() - now;
  if (Number.isNaN(remaining)) {
    return null;
  }
  const overdue = remaining < 0;
  return (
    <StatusBadge status={overdue ? "error" : "info"} size="sm">
      {overdue ? `Overdue by ${formatDuration(remaining)}` : `Due in ${formatDuration(remaining)}`}
    </StatusBadge>
  );
}

export interface QueueListProps {
  items: QueueItem[];
  state: SurfaceState;
  emptyMessage: string;
  /** Injectable clock so relative times are deterministic in tests. */
  now?: number;
  onRetry?: () => void;
  onClearFilters?: () => void;
}

/**
 * Relative times are read against the *viewer's* clock, so the reading is
 * taken after mount rather than during render: a server-rendered timestamp
 * would hydrate to a different value, and reading the clock in render is
 * impure. Until the first effect runs, durations are withheld rather than
 * guessed.
 */
function useClock(provided?: number): number | null {
  const [mountedAt, setMountedAt] = useState<number | null>(null);
  useEffect(() => {
    setMountedAt(Date.now());
  }, []);
  return provided ?? mountedAt;
}

/**
 * A list of things waiting on a human. Not a table: queue rows are read as
 * units ("what is this, how long has it waited, is it late"), so they get a
 * card-ish row rather than columns.
 */
export function QueueList({
  items,
  state,
  emptyMessage,
  now,
  onRetry,
  onClearFilters,
}: QueueListProps) {
  const clock = useClock(now);

  if (state.kind !== "ready") {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage={emptyMessage}
        onRetry={onRetry}
        onClearFilters={onClearFilters}
      />
    );
  }

  return (
    <ul className="divide-y divide-border border-t border-border">
      {items.map((item) => {
        const waited =
          clock === null ? Number.NaN : clock - new Date(item.waitingSince).getTime();
        return (
          <li key={item.key} className="flex items-start gap-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={item.href} className="text-sm font-medium hover:underline">
                  {item.title}
                </Link>
                <Badge variant="outline">{item.product}</Badge>
                {item.status ? (
                  <StatusBadge status={item.status.tone ?? "neutral"} size="sm">
                    {item.status.label}
                  </StatusBadge>
                ) : null}
                <StatusBadge
                  status={SEVERITY_STATUS[item.severity]}
                  size="sm"
                  className="capitalize"
                >
                  {item.severity}
                </StatusBadge>
              </div>
              {item.subtitle ? (
                <p className="mt-1 truncate text-sm text-muted-foreground">{item.subtitle}</p>
              ) : null}
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {Number.isNaN(waited) ? "waiting" : `waiting ${formatDuration(waited)}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {item.dueAt && clock !== null ? (
                <SlaIndicator dueAt={item.dueAt} now={clock} />
              ) : null}
              {item.actions}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
