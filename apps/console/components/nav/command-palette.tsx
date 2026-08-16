"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@tesserix/web";
import {
  MIN_TICKET_QUERY,
  routeEntries,
  toolEntries,
  visibleTo,
  type SearchEntry,
  type SearchKind,
} from "@/lib/search";

export interface CommandPaletteProps {
  readonly capabilities: readonly string[];
  readonly enforceCapabilities: boolean;
  readonly toolsBaseDomain: string;
}

/**
 * The console's ⌘K palette: routes, internal tools and live ticket search
 * in one flat list, ranked Tickets → Routes → Tools because a ticket is
 * usually what an operator is hunting.
 *
 * `@tesserix/web`'s `Command` primitive keeps its own filtering `query` as
 * private context state — it is not exposed to the parent, and passing a
 * `value`/`onChange` pair straight to `CommandInput` would shadow the
 * internal handler that drives it (its `...props` spread lands after those
 * two). So this component tracks its own `query` via the additive `onInput`
 * event, purely to drive the ticket fetch, the empty-state copy and the
 * loading row's keywords — filtering itself is still `Command`'s job.
 *
 * Selection is dispatched through `Command`'s own `onValueChange`: every
 * `CommandItem`'s built-in click handler already calls it with the item's
 * `value`, and `Command`'s own key handler calls it again on Enter for the
 * active item — so wiring navigation there covers both mouse and keyboard in
 * one place instead of attaching a duplicate `onClick` per item.
 *
 * Keyboard navigation needs nothing from this component. Up to `@tesserix/web`
 * 1.8.1 it did: the primitive bound the arrows and Enter to `CommandList`'s
 * own `onKeyDown`, a handler on the listbox div, which is a *sibling* of the
 * search input rather than an ancestor of it — so a keydown fired while the
 * operator was typing never reached it and the palette had no keyboard
 * navigation at all. This file carried a `forwardToListbox` shim that
 * re-dispatched those keys onto the listbox node. 2.1.0 moved the handler onto
 * `Command`'s wrapper (design-system#7), which *is* an ancestor of both, and
 * the shim is deleted.
 */
export function ConsoleCommandPalette({
  capabilities,
  enforceCapabilities,
  toolsBaseDomain,
}: CommandPaletteProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tickets, setTickets] = useState<SearchEntry[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);

  const routes = useMemo(
    () => visibleTo(routeEntries(), capabilities, enforceCapabilities),
    [capabilities, enforceCapabilities],
  );
  const tools = useMemo(
    () => visibleTo(toolEntries(toolsBaseDomain), capabilities, enforceCapabilities),
    [capabilities, enforceCapabilities, toolsBaseDomain],
  );

  // Global ⌘K/Ctrl+K. Skipped while focus sits in some other input, textarea
  // or contenteditable — an operator typing in a form field elsewhere in the
  // console should get a literal "k", not a stolen keystroke. The palette's
  // own search input is exempt (comparing against the DOM node itself,
  // rather than "is this the palette" by ancestry) so the shortcut still
  // behaves sanely while the palette is already open.
  useEffect(() => {
    function isTypingElsewhere(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      const isFormField = tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
      if (!isFormField) return false;
      // `CommandInput` renders its `<input>` inside a `cmdk-input-wrapper`
      // container — being inside it means this is the palette's own search
      // field, which the shortcut must not be blocked by.
      return target.closest("[cmdk-input-wrapper]") === null;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      if (isTypingElsewhere(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Debounced, abortable ticket search. Skips the network entirely below
  // MIN_TICKET_QUERY, and any failure — network error, 4xx/5xx, a parked
  // 501, malformed JSON — degrades to "no tickets" rather than surfacing an
  // error: the palette must stay usable for routes and tools even when the
  // database is unreachable.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_TICKET_QUERY) {
      setTickets([]);
      setLoadingTickets(false);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setLoadingTickets(true);
    const timer = setTimeout(() => {
      void fetchTicketEntries(trimmed, controller.signal).then((rows) => {
        if (!active) return;
        setTickets(rows);
        setLoadingTickets(false);
      });
    }, TICKET_DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const allEntries = useMemo(
    () => [...tickets, ...routes, ...tools],
    [tickets, routes, tools],
  );

  // Keyed by the same `paletteValue` used on each `CommandItem`, so lookup
  // and rendering can never drift apart into looking one entry up while
  // displaying another.
  const entriesByPaletteValue = useMemo(
    () => new Map(allEntries.map((entry) => [paletteValue(entry), entry])),
    [allEntries],
  );

  const selectEntry = useCallback(
    (value: string) => {
      const entry = entriesByPaletteValue.get(value);
      if (!entry || entry.disabled) return;
      // WORKAROUND for a `@tesserix/web` `Command`/`CommandInput` bug:
      // `CommandInput`'s `onChange` sets the active value from
      // `getVisibleItems()[0]` synchronously, before the newly-filtered
      // items have re-registered for the new query. So on the very next
      // Enter after a keystroke, `activeValue` can still point at an entry
      // left over from the *previous* query — stale but truthy — and
      // `CommandList`'s Enter handler only checks truthiness before firing
      // `onValueChange` against it. That would silently navigate to
      // whatever was highlighted before the operator's last keystroke, even
      // though nothing currently on screen matches what they typed. Guard
      // against it here using the same matcher `hasAnyMatch` uses, so a
      // phantom selection that no longer matches the live query is ignored
      // instead of navigated to. Delete this guard if the upstream bug is
      // fixed.
      if (!matchesEntryQuery(entry, query)) return;
      if (entry.external) {
        window.open(entry.href, "_blank", "noopener,noreferrer");
      } else {
        router.push(entry.href);
      }
      setOpen(false);
      setQuery("");
    },
    [entriesByPaletteValue, router, query],
  );

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>Search</span>
        <CommandShortcut>⌘K</CommandShortcut>
      </button>

      <CommandDialog open={open} onOpenChange={handleOpenChange}>
        <Command onValueChange={selectEntry}>
          <CommandInput
            placeholder="Search routes, tools and tickets…"
            // The global `:focus-visible` rule (apps/console/app/globals.css)
            // draws its ring with `outline-offset: 3px`, i.e. outside the
            // element's box. This input sits flush against the dialog
            // panel's top edge (`CommandInput`'s wrapper is
            // `flex items-center border-b px-3` with no vertical padding,
            // and `CommandDialog` renders `p-0`), and the panel itself
            // clips with `overflow-hidden` — so the outward ring gets
            // sliced off at the top. Pulling the offset negative draws the
            // full 2px ring band *inside* the input's own box instead
            // (band spans -2px to 0 from the border edge), so nothing is
            // ever painted past the box the panel clips to. This same trap
            // — a focusable element sitting flush inside an
            // `overflow-hidden` container — will bite anywhere else in the
            // console that has one; it isn't unique to this input.
            className="focus-visible:outline-offset-[-2px]"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
          <CommandList className="space-y-2 p-3">
            {/* `CommandEmpty` again, rather than a hand-computed empty state.
                Up to 1.8.1 `CommandItem` only registered itself when
                `matchesQuery && !disabled`, so the couple of dozen pending
                (disabled) routes this palette lists never counted — with an
                empty query `CommandEmpty` saw zero registrations and rendered
                "Nothing matching…" directly above a screenful of matching
                rows. The workaround recomputed the empty state here from a
                copy of the primitive's own matcher, read out of its compiled
                source; 2.1.0 registers on `matchesQuery` alone and counts what
                is actually rendered, so the copy — and the way it would have
                drifted the moment the primitive's matcher changed — is gone. */}
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
              Nothing matching that in routes, tools or tickets.
            </CommandEmpty>

            {loadingTickets || tickets.length > 0 ? (
              <CommandGroup>
                <GroupHeading>Tickets</GroupHeading>
                {loadingTickets ? (
                  <CommandItem
                    value={`__loading__:${query}`}
                    keywords={[query]}
                    disabled
                    className="px-3 py-2.5"
                  >
                    Searching tickets…
                  </CommandItem>
                ) : (
                  tickets.map((entry) => <PaletteItem key={entry.id} entry={entry} />)
                )}
              </CommandGroup>
            ) : null}

            <CommandGroup>
              <GroupHeading>Routes</GroupHeading>
              {routes.map((entry) => (
                <PaletteItem key={entry.id} entry={entry} />
              ))}
            </CommandGroup>

            <CommandGroup>
              <GroupHeading>Tools</GroupHeading>
              {tools.map((entry) => (
                <PaletteItem key={entry.id} entry={entry} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

const TICKET_DEBOUNCE_MS = 250;

const KIND_BADGE: Record<SearchEntry["kind"], string> = {
  route: "Route",
  tool: "Tool",
  ticket: "Ticket",
};

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-command-group-heading=""
      className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
    >
      {children}
    </p>
  );
}

/**
 * `CommandItem`'s value must be unique — labels are not (two tickets can
 * share `` `${number} — ${subject}` `` when ticket numbers repeat across
 * products, per `search.ts`'s `ticketEntry` doc), and a colliding `value`
 * would make selection resolve to the wrong entry.
 *
 * `entry.id` itself is unique but is the wrong thing to hand to `value`:
 * `CommandItem` also matches queries against `value` (`[value,
 * ...keywords].join(" ")`, read from the compiled `@tesserix/web` source),
 * and `entry.id`'s human-readable `ticket:`/`route:`/`tool:` prefix would
 * make typing the bare word "ticket" match every ticket entry regardless of
 * its actual content — the exact whole-word collision this scheme exists to
 * avoid. A single-letter code carries the same uniqueness without putting
 * an English word in the haystack for a query to collide with.
 */
const KIND_CODE: Record<SearchKind, string> = { ticket: "t", route: "r", tool: "x" };

/**
 * Derives a unique, non-lexical `CommandItem` value from an entry.
 *
 * `entry.id` is `${kind}:${raw}` — the raw half is taken by slicing past
 * `entry.kind.length + 1`, not by splitting on the first colon, so a raw id
 * that happens to itself contain a colon cannot be mis-split.
 */
function paletteValue(entry: SearchEntry): string {
  const raw = entry.id.slice(entry.kind.length + 1);
  return `${KIND_CODE[entry.kind]}:${raw}`;
}

function PaletteItem({ entry }: { entry: SearchEntry }) {
  return (
    <CommandItem
      value={paletteValue(entry)}
      keywords={[...entry.keywords, entry.label]}
      disabled={entry.disabled}
      className="px-3 py-2.5"
    >
      <span className="mr-2 inline-flex w-14 shrink-0 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {KIND_BADGE[entry.kind]}
      </span>
      <span className="flex-1 truncate text-left">
        <span className="block truncate text-sm">{entry.label}</span>
        {entry.hint ? (
          <span className="block truncate text-xs text-muted-foreground">{entry.hint}</span>
        ) : null}
      </span>
    </CommandItem>
  );
}

async function fetchTicketEntries(
  query: string,
  signal: AbortSignal,
): Promise<SearchEntry[]> {
  let response: Response;
  try {
    response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal });
  } catch {
    return [];
  }

  if (!response.ok) {
    // Every non-200 — 400 too short (shouldn't happen past MIN_TICKET_QUERY),
    // 403 unauthorized, 501 not configured, 500 unavailable — collapses to
    // "no tickets" here rather than throwing.
    return [];
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return [];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }

  if (typeof body !== "object" || body === null || !Array.isArray((body as { items?: unknown }).items)) {
    return [];
  }

  return (body as { items: SearchEntry[] }).items;
}
