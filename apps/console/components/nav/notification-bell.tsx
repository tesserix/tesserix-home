"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Bell } from "lucide-react";
import {
  NOTIFICATION_KINDS,
  type NotificationFeed,
  type NotificationItem,
} from "@/lib/notifications";

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
 *
 * `NotificationItem` is now a union, so an item's `kind` is no longer
 * guaranteed to be one this build knows how to render. An unrecognised kind
 * that reached `NotificationRow` unchecked would render as a broken ticket
 * link (or, once a variant with different fields exists, as `undefined`
 * spliced into the DOM) rather than falling back cleanly — so this check
 * inspects each item's `kind`, not just the feed's outer shape.
 */
function isNotificationFeedShape(value: unknown): value is NotificationFeed {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.items) &&
    candidate.items.every(hasRecognisedKind) &&
    typeof candidate.unread === "number" &&
    Number.isFinite(candidate.unread)
  );
}

/** Checks only the discriminant, against the single exported list of known
 *  kinds — not the rest of an item's shape, which stays out of scope for a
 *  boundary check this proportionate. */
function hasRecognisedKind(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const kind = (item as { kind?: unknown }).kind;
  return typeof kind === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(kind);
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

/** Throws for a `NotificationItem` no `switch` below handles. Called with
 *  the whole `item`, not `item.kind`: `NotificationItem` is now a
 *  discriminated union across two separate interfaces, so once a `switch`
 *  has consumed every member's `kind` literal, TypeScript narrows `item`
 *  ITSELF to `never` — and property access on a `never`-typed value
 *  (`item.kind`) is a type error, not a value of type `never`. That only
 *  showed up once a second interface joined the union; a single-interface
 *  `kind` field narrowed to `never` while `item` stayed a real object, so
 *  `item.kind` used to typecheck. The parameter type is `never` only when
 *  every case has actually been handled, so a future kind that falls
 *  through a `switch`'s cases (rather than being deliberately handled) is a
 *  COMPILE error here, not a runtime one — the failure it guards against is
 *  a new variant silently rendering as a broken ticket link, and catching
 *  that at the type level is stronger than any test could be. */
function assertNever(value: never): never {
  throw new Error(`notification-bell: unhandled kind ${JSON.stringify(value)}`);
}

function leadingPhrase(item: NotificationItem): string {
  // Exhaustive switch, not a binary ternary: the NotificationItem union has
  // three members today, and a ternary's "else" branch would silently
  // swallow any member beyond the first two instead of failing to compile.
  switch (item.kind) {
    case "ticket_created":
      return "New ticket";
    case "merchant_reply":
      return `${item.actor} replied`;
    case "access_proposal_open":
      return "Access proposal waiting";
    case "access_proposal_merged":
      return "Your request is live";
    default:
      return assertNever(item);
  }
}

/** The href is decided per variant, not assumed — today every ticket kind
 *  links to a ticket, but that is a per-case decision, not a fact about
 *  NotificationItem as a whole. An access proposal links to the review
 *  detail route (`/platform/secrets/reviews/{number}`), not a ticket path —
 *  it isn't a ticket, it's an open pull request against tesserix-k8s. */
function hrefFor(item: NotificationItem): string {
  switch (item.kind) {
    case "ticket_created":
    case "merchant_reply":
      return `/platform/tickets/${item.ticketId}`;
    case "access_proposal_open":
    case "access_proposal_merged":
      return `/platform/secrets/reviews/${item.number}`;
    default:
      return assertNever(item);
  }
}

/** The row's identifying number, next to `leadingPhrase` — a ticket number
 *  for the two ticket kinds, the pull-request number for a proposal. */
function identifierFor(item: NotificationItem): string {
  switch (item.kind) {
    case "ticket_created":
    case "merchant_reply":
      return item.ticketNumber;
    case "access_proposal_open":
    case "access_proposal_merged":
      return `#${item.number}`;
    default:
      return assertNever(item);
  }
}

/** The row's second line. For ticket kinds this is the ticket's subject.
 *  A proposal has no subject and no requester on the wire (see
 *  `AccessProposalNotification`'s doc comment in `lib/notifications.ts` —
 *  `secrets-api` never parses the requester out of the pull request body),
 *  so the honest, useful line here is WHAT is waiting: the namespace/app
 *  targets the proposal touches, not who raised it. */
function secondaryFor(item: NotificationItem): string {
  switch (item.kind) {
    case "ticket_created":
    case "merchant_reply":
      return item.subject;
    case "access_proposal_open":
    case "access_proposal_merged":
      return item.targets.length > 0 ? item.targets.join(", ") : "No targets recorded";
    default:
      return assertNever(item);
  }
}

function NotificationRow({ item }: { item: NotificationItem }) {
  return (
    <Link
      href={hrefFor(item)}
      className="flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-[13px] transition-colors hover:bg-accent"
    >
      <span className="font-medium text-foreground">
        {leadingPhrase(item)} · {identifierFor(item)}
      </span>
      <span className="truncate text-muted-foreground">{secondaryFor(item)}</span>
      <span className="text-[11px] text-muted-foreground">
        {/* `at` is `undefined` only for an access proposal whose upstream
            GitHub timestamp failed to parse (see AccessProposalNotification's
            doc comment) — render nothing rather than passing `undefined`
            into `formatRelativeTime`, which expects a string. */}
        {item.at !== undefined ? formatRelativeTime(item.at) : null}
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
        className="relative flex items-center justify-center rounded-md border border-border bg-background p-2 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 disabled:hover:bg-background"
      >
        <Bell aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
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
