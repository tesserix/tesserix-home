"use client";

// O3 — Global Cmd+K command palette.
//
// Two intents in one box:
// 1. Static admin surfaces — typing "uptime", "outbox", "audit" jumps you to
//    the page. Adding a new entry to ADMIN_DESTINATIONS shows up here.
// 2. Cross-product user search — when ≥3 chars are typed, hit the existing
//    /api/admin/users/search and show inline grouped results. Email queries
//    surface a "consolidated profile" link to /admin/users/[email] same as
//    the header dropdown.
//
// Implementation note: @tesserix/web's Command primitive is a custom
// (non-cmdk) implementation that exposes selection via `onValueChange` on
// the Command wrapper rather than a per-item `onSelect`. We register a
// value→handler map and dispatch on Enter or click.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  Activity,
  Cloud,
  CreditCard,
  HeartPulse,
  Inbox,
  KeyRound,
  Mail,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  ScrollText,
  Search,
  Settings,
  Shield,
  Users,
  ClipboardList,
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@tesserix/web";

interface UserSearchResult {
  source: string;
  kind: string;
  email: string;
  label: string;
  sublabel?: string;
  href: string;
  matchedField: string;
  updatedAt: string | null;
}

interface SearchResponse {
  query: string;
  results: UserSearchResult[];
  failures: { source: string; message: string }[];
  truncated: boolean;
}

interface Destination {
  group: "Platform" | "Mark8ly";
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  // Extra keywords help fuzzy-match — e.g. "GDPR queue" matches "erasure"
  keywords?: string[];
}

const ADMIN_DESTINATIONS: ReadonlyArray<Destination> = [
  { group: "Platform", label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { group: "Platform", label: "Apps", href: "/admin/apps", icon: Cloud },
  {
    group: "Platform",
    label: "Platform tickets",
    href: "/admin/platform-tickets",
    icon: LifeBuoy,
    keywords: ["support"],
  },
  {
    group: "Platform",
    label: "Announcements",
    href: "/admin/platform-announcements",
    icon: Megaphone,
    keywords: ["banner", "broadcast"],
  },
  {
    group: "Platform",
    label: "Uptime",
    href: "/admin/uptime",
    icon: Activity,
    keywords: ["synthetic", "probe", "health"],
  },
  {
    group: "Platform",
    label: "Service health",
    href: "/admin/health",
    icon: HeartPulse,
    keywords: ["pods", "replicas", "restarts", "k8s", "kubernetes"],
  },
  {
    group: "Platform",
    label: "Outbox events",
    href: "/admin/outbox",
    icon: Inbox,
    keywords: ["stuck", "queue", "events"],
  },
  {
    group: "Platform",
    label: "Email templates",
    href: "/admin/notifications/templates",
    icon: Mail,
    keywords: ["template", "notification", "email", "registry"],
  },
  {
    group: "Platform",
    label: "Lead templates",
    href: "/admin/notifications/lead-templates",
    icon: Mail,
    keywords: ["lead", "marketing", "invite", "outreach"],
  },
  {
    group: "Platform",
    label: "GDPR / erasure queue",
    href: "/admin/erasure-requests",
    icon: Shield,
    keywords: ["erasure", "gdpr", "delete", "right to be forgotten"],
  },
  {
    group: "Platform",
    label: "Break-glass accounts",
    href: "/admin/break-glass",
    icon: KeyRound,
    keywords: ["emergency", "access", "audit"],
  },
  { group: "Platform", label: "Settings", href: "/admin/settings", icon: Settings },
  {
    group: "Platform",
    label: "Cross-product search",
    href: "/admin/search",
    icon: Search,
    keywords: ["users", "find"],
  },
  {
    group: "Mark8ly",
    label: "Overview",
    href: "/admin/apps/mark8ly",
    icon: LayoutDashboard,
  },
  { group: "Mark8ly", label: "Tenants", href: "/admin/apps/mark8ly/tenants", icon: Users },
  {
    group: "Mark8ly",
    label: "Onboarding funnel",
    href: "/admin/apps/mark8ly/onboarding",
    icon: ClipboardList,
    keywords: ["funnel", "signups"],
  },
  {
    group: "Mark8ly",
    label: "Subscriptions",
    href: "/admin/apps/mark8ly/subscriptions",
    icon: CreditCard,
    keywords: ["billing", "stripe", "trial"],
  },
  {
    group: "Mark8ly",
    label: "Audit logs",
    href: "/admin/apps/mark8ly/audit-logs",
    icon: ScrollText,
  },
  { group: "Mark8ly", label: "Leads", href: "/admin/apps/mark8ly/leads", icon: ClipboardList },
];

const SEARCH_MIN_LENGTH = 3;
const SEARCH_LIMIT = 6;
const SEARCH_DEBOUNCE_MS = 250;

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function looksLikeEmail(q: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Map of "value" → action, populated as items render. We can't pass
  // onSelect to CommandItem (the custom Command primitive doesn't accept
  // it), so we keep the dispatch table here and look it up in
  // onValueChange. Plain Map (not a ref) so the lint rule against
  // accessing refs during render stays happy — onValueChange captures
  // this map by closure for the current render cycle, which is what
  // we want anyway since the items rebuild each render.
  const handlers = new Map<string, () => void>();

  // Reset query when palette closes — opening fresh shouldn't show
  // residue from the last search.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(
      () => setDebounced(query.trim().toLowerCase()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [query]);

  const shouldSearch = open && debounced.length >= SEARCH_MIN_LENGTH;
  const swrKey = shouldSearch
    ? `/api/admin/users/search?q=${encodeURIComponent(debounced)}`
    : null;
  const { data, isLoading } = useSWR<SearchResponse>(swrKey, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const userResults = (data?.results ?? []).slice(0, SEARCH_LIMIT);
  const isEmailQuery = looksLikeEmail(debounced);

  const navigate = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  // Register a handler for a value and return the value back. Used in
  // render so the JSX stays declarative. The map is rebuilt fresh
  // each render (it's a plain Map declared above, not a ref).
  function bindAction(value: string, action: () => void): string {
    handlers.set(value, action);
    return value;
  }

  const grouped = useMemo(
    () =>
      ADMIN_DESTINATIONS.reduce<Record<string, Destination[]>>((acc, d) => {
        (acc[d.group] ??= []).push(d);
        return acc;
      }, {}),
    [],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command
        onValueChange={(value: string) => {
          const handler = handlers.get(value);
          if (handler) handler();
        }}
      >
        {/*
         * NOTE: don't pass `value`/`onChange` here — @tesserix/web's
         * CommandInput spreads `...props` AFTER its internal value/onChange,
         * so passing them would shadow the internal handler that updates the
         * context's `query` state, which is what drives CommandItem filtering.
         * We mirror via `onInput` (additive) so we get the typed value too,
         * for our debounced user-search SWR fetch and the empty-state hint.
         */}
        <CommandInput
          placeholder="Type a command, page, or search for a user…"
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <CommandList>
          <CommandEmpty>
            {isLoading
              ? "Searching…"
              : debounced.length > 0 && debounced.length < SEARCH_MIN_LENGTH
                ? `Type at least ${SEARCH_MIN_LENGTH} characters to search users.`
                : "Nothing found."}
          </CommandEmpty>

          {Object.entries(grouped).map(([group, items]) => (
            <CommandGroup key={group}>
              <p
                data-command-group-heading=""
                className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
              >
                {group}
              </p>
              {items.map((d) => {
                const Icon = d.icon;
                const value = bindAction(`nav:${d.href}`, () => navigate(d.href));
                return (
                  <CommandItem
                    key={d.href}
                    value={value}
                    keywords={[d.label, ...(d.keywords ?? [])]}
                  >
                    <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                    <span>{d.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}

          {isEmailQuery && (
            <>
              <CommandSeparator />
              <CommandGroup>
                <p
                  data-command-group-heading=""
                  className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
                >
                  Email lookup
                </p>
                <CommandItem
                  value={bindAction(`profile:${debounced}`, () =>
                    navigate(`/admin/users/${encodeURIComponent(debounced)}`),
                  )}
                  keywords={[debounced, "profile", "user"]}
                >
                  <Users className="mr-2 h-4 w-4" aria-hidden="true" />
                  <span>Open consolidated profile for {debounced}</span>
                </CommandItem>
              </CommandGroup>
            </>
          )}

          {userResults.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup>
                <p
                  data-command-group-heading=""
                  className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
                >
                  Users
                </p>
                {userResults.map((r, i) => (
                  <CommandItem
                    key={`${r.source}-${i}`}
                    value={bindAction(`user:${r.source}:${i}:${r.href}`, () =>
                      navigate(r.href),
                    )}
                    keywords={[r.label, r.email, r.source, r.kind]}
                  >
                    <span className="mr-2 inline-flex w-20 shrink-0 justify-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {r.kind}
                    </span>
                    <span className="flex-1 truncate text-left">
                      <span className="block truncate text-sm">{r.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.email}
                        {r.sublabel ? ` · ${r.sublabel}` : ""}
                      </span>
                    </span>
                  </CommandItem>
                ))}
                {data && data.results.length > SEARCH_LIMIT && (
                  <CommandItem
                    value={bindAction("view-all-results", () =>
                      navigate(`/admin/search?q=${encodeURIComponent(debounced)}`),
                    )}
                    keywords={["all", "more", "view"]}
                  >
                    <Search className="mr-2 h-4 w-4" aria-hidden="true" />
                    <span>
                      View all {data.truncated ? "100+" : data.results.length} matches…
                    </span>
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}
        </CommandList>
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <span>
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↑↓
            </kbd>{" "}
            navigate ·{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>{" "}
            open ·{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
              esc
            </kbd>{" "}
            close
          </span>
          <CommandShortcut>⌘K</CommandShortcut>
        </div>
      </Command>
    </CommandDialog>
  );
}

// ─── Provider + global keyboard hook ──────────────────────────────────
//
// Mounted once at the admin layout level. Listens for Cmd/Ctrl+K and
// toggles the dialog. Exposes a context so any descendant (e.g. a
// header button) can open the palette without prop-drilling.

interface CommandPaletteContextValue {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  }
  return ctx;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isPaletteShortcut =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (!isPaletteShortcut) return;
      e.preventDefault();
      setIsOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CommandPaletteContext.Provider value={{ open, close, toggle, isOpen }}>
      {children}
      <CommandPalette open={isOpen} onOpenChange={setIsOpen} />
    </CommandPaletteContext.Provider>
  );
}
