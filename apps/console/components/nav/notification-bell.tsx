"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Bell } from "lucide-react";
import type { NotificationFeed, NotificationItem } from "@/lib/notifications";

const FEED_URL = "/api/notifications";
const POLL_INTERVAL_MS = 60_000;
const DISPLAY_CAP = 9;

/**
 * SWR's data shape when the feed cannot be trusted: a parked data plane
 * (501), a non-2xx status, a non-JSON content-type, or a body that fails to
 * parse. All four collapse to the same marker rather than throwing, because
 * throwing would make SWR retry — and a bell that hammers a parked endpoint
 * every 60s is noise in the logs and load on the pod. The unavailable state
 * turns polling off entirely (see `useSWR` options below).
 */
const UNAVAILABLE = "unavailable" as const;
type FeedResult = NotificationFeed | typeof UNAVAILABLE;

async function fetchFeed(url: string): Promise<FeedResult> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return UNAVAILABLE;
  }

  if (!response.ok) {
    return UNAVAILABLE;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // An expired session answers a poll with the login page's HTML, not
    // JSON — the middleware matcher covers /api/*.
    return UNAVAILABLE;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return UNAVAILABLE;
  }

  if (!isNotificationFeedShape(body)) {
    return UNAVAILABLE;
  }

  return body;
}

/**
 * Proportionate shape check, not full schema validation — this is the one
 * boundary where a malformed payload becomes a broken sidebar on every
 * console page, so a wrong-shaped body must fall back to `UNAVAILABLE`
 * rather than render garbage or throw.
 */
function isNotificationFeedShape(value: unknown): value is NotificationFeed {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.unread === "number" &&
    Number.isFinite(candidate.unread)
  );
}

function isUnavailable(result: FeedResult | undefined): result is typeof UNAVAILABLE {
  return result === UNAVAILABLE;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function leadingPhrase(item: NotificationItem): string {
  return item.kind === "ticket_created" ? "New ticket" : `${item.actor} replied`;
}

function NotificationRow({ item }: { item: NotificationItem }) {
  return (
    <Link
      href={`/platform/tickets/${item.ticketId}`}
      className="flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-[13px] transition-colors hover:bg-accent"
    >
      <span className="font-medium text-foreground">
        {leadingPhrase(item)} · {item.ticketNumber}
      </span>
      <span className="truncate text-muted-foreground">{item.subject}</span>
      <span className="text-[11px] text-muted-foreground">
        {formatRelativeTime(item.at)}
      </span>
    </Link>
  );
}

/**
 * The console's bell: unread ticket activity, polled at a low cadence and
 * rendered inert rather than alarming whenever the feed cannot be trusted.
 *
 * @tesserix/web has no Popover export (checked its barrel's type
 * declarations), so the panel here is a hand-rolled absolutely-positioned
 * `role="dialog"` that closes on Escape and outside click, matching the
 * pattern already used by the sidebar's own RailSwitcher menu.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, mutate } = useSWR<FeedResult>(FEED_URL, fetchFeed, {
    refreshInterval: (latest) => (isUnavailable(latest) ? 0 : POLL_INTERVAL_MS),
    shouldRetryOnError: false,
  });

  useEffect(() => {
    if (!open) return;
    function onDocumentPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const unavailable = isUnavailable(data);
  const feed = unavailable ? undefined : data;
  const unread = feed?.unread ?? 0;
  const items = feed?.items ?? [];

  function handleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      // POST unconditionally on open, not just when `unread > 0`: a fresh
      // operator has no `console_notification_reads` row, so `lastSeenAt` is
      // null and `countUnread` returns 0 no matter how many items exist.
      // Gating the POST on `unread > 0` would mean it never fires, so
      // `lastSeenAt` never gets set, so `unread` never leaves zero — a
      // deadlock. The write is one row per open on a two-operator internal
      // console, so there is nothing worth optimising here.
      //
      // Mark-as-read then revalidate so the badge clears. A failed POST
      // leaves the badge alone and surfaces nothing — the operator's
      // attention state failing to save is not worth interrupting them for.
      void fetch(FEED_URL, { method: "POST" })
        .then(() => mutate())
        .catch(() => {
          /* deliberately silent — see comment above */
        });
    }
  }

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  const badgeText = unread > DISPLAY_CAP ? `${DISPLAY_CAP}+` : String(unread);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        disabled={unavailable}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className="relative flex w-full items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 disabled:hover:bg-sidebar-accent/60"
      >
        <Bell aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/70" />
        <span className="truncate text-[13px] text-sidebar-foreground/75">Notifications</span>
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="ml-auto grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-sidebar-primary px-1 text-[10px] font-semibold text-sidebar-primary-foreground"
          >
            {badgeText}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
        >
          {items.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
              Nothing waiting.
            </p>
          ) : (
            <div className="space-y-0.5 p-1.5">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
