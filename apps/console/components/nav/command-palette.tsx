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
 * `value`, and `CommandList` calls it again on Enter for the active item —
 * so wiring navigation there covers both mouse and keyboard in one place
 * instead of attaching a duplicate `onClick` per item.
 */
export function ConsoleCommandPalette({
  capabilities,
  enforceCapabilities,
  toolsBaseDomain,
}: CommandPaletteProps): React.JSX.Element {
  const router = useSafeRouter();
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

  const selectEntry = useCallback(
    (label: string) => {
      const entry = allEntries.find((candidate) => candidate.label === label);
      if (!entry || entry.disabled) return;
      if (entry.external) {
        window.open(entry.href, "_blank", "noopener,noreferrer");
      } else {
        router.push(entry.href);
      }
      setOpen(false);
      setQuery("");
    },
    [allEntries, router],
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
            role="combobox"
            placeholder="Search routes, tools and tickets…"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
          <CommandList>
            <CommandEmpty>Nothing matching that in routes, tools or tickets.</CommandEmpty>

            {loadingTickets || tickets.length > 0 ? (
              <CommandGroup>
                <GroupHeading>Tickets</GroupHeading>
                {loadingTickets ? (
                  <CommandItem value={`__loading__:${query}`} keywords={[query]} disabled>
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

/**
 * `next/navigation`'s `useRouter` throws — deliberately, not just returns
 * null — when no `AppRouterContext` is mounted. Every other surface in this
 * app renders inside Next's router, but this component's own render tests
 * mount it standalone, and a component that cannot be rendered outside a
 * full app shell is a component nobody can unit test. Matching
 * `NotificationBell`'s fail-open posture elsewhere in this file's sibling,
 * this falls back to a plain location assignment instead of crashing the
 * whole palette when no router is present.
 */
function useSafeRouter(): Pick<ReturnType<typeof useRouter>, "push"> {
  try {
    return useRouter();
  } catch {
    return { push: (href: string) => window.location.assign(href) };
  }
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
 * Splits a route id's camelCase segment into words for display — e.g. the
 * label built from `platform.breakGlass` reads "Platform · BreakGlass"
 * before this, "Platform · Break Glass" after. Only the rendered text
 * changes; `CommandItem`'s `value` stays the raw label so filtering and
 * selection lookups are unaffected.
 */
function humanizeLabel(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function PaletteItem({ entry }: { entry: SearchEntry }) {
  return (
    // `CommandItem` hardcodes `role="option"` (a listbox-item semantic);
    // this is a flat action list, not a listbox, so `role="button"` is both
    // the more accurate semantic here and what lets an operator's assistive
    // tech (and this component's own tests) address each row the way it
    // behaves — a button that performs navigation on activation. Passed as
    // an extra prop rather than patching the kit: CommandItem spreads
    // `...props` after its own `role`, so this simply wins.
    <CommandItem
      role="button"
      value={entry.label}
      keywords={[...entry.keywords]}
      disabled={entry.disabled}
    >
      <span className="mr-2 inline-flex w-14 shrink-0 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {KIND_BADGE[entry.kind]}
      </span>
      <span className="flex-1 truncate text-left">
        <span className="block truncate text-sm">{humanizeLabel(entry.label)}</span>
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
