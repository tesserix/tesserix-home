"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import {
  isPending,
  isNavGroup,
  isMostSpecificActiveRoute,
  isRouteActive,
  navItems,
  consolePath,
  productLabel,
  visibleNav,
  PRODUCT_IDS,
  RAIL_IDS,
  railNav,
  type NavEntry,
  type NavGroup,
  type RailId,
  type RouteId,
} from "@tesserix/console-core";
import { NavIcon } from "./icon";

/**
 * How a rail is DRAWN. Which rails exist is console-core's answer, not this
 * file's — `RAIL_IDS` and `railNav` supply the set and its contents, so adding
 * a product to the registry gives it a rail with no edit here. Pinned by
 * "offers every rail the registry declares, in registry order" and "dresses a
 * rail that has no entry in the presentation map" in sidebar.render.test.tsx.
 *
 * Presentation stays here because `logo` is an `apps/console/public/` path and
 * console-core is a pure data package compiled into web, mobile and console —
 * `routes.ts` refuses even a value import of `Capability` to keep it that way.
 *
 * `logo` wins over `mark` when present, and `onLight` says whether the artwork
 * needs a background painted for it. The two logos differ in kind, not just in
 * image. Tesserix is navy on TRANSPARENT: it needs a light chip in both
 * themes, or it vanishes against a dark sidebar. Kora's app icon is
 * SELF-CONTAINED — its own dark gradient, already a rounded square — so
 * painting anything behind it would show as a halo. Hence the flag rather than
 * one shared wrapper.
 *
 * PARTIAL, and that is the mechanism rather than an omission. A
 * `Record<RailId, …>` would make every new product a compile error here, which
 * is exactly the fourth list `products.ts` exists to remove. A rail with no
 * entry falls back to `railPresentation` below.
 */
interface RailPresentation {
  readonly mark: string;
  readonly logo?: string;
  readonly onLight?: boolean;
  readonly section: string;
}

const RAIL_PRESENTATION: Readonly<Partial<Record<RailId, RailPresentation>>> = {
  platform: {
    mark: "T",
    logo: "/tesserix-mark.png",
    onLight: true,
    section: "Operate",
  },
  kora: {
    mark: "K",
    logo: "/kora-mark.png",
    onLight: false,
    section: "Product",
  },
  // No `logo`: `apps/console/public/` holds `kora-mark.png` and
  // `tesserix-mark.png` and nothing for mark8ly, so a letter mark is what
  // there is. `RailMark` already renders that shape.
  mark8ly: { mark: "M", section: "Product" },
};

/** The rail's display name. */
function railLabel(id: RailId): string {
  // `productLabel` cannot answer for "platform" — it is not a product, and
  // `products.ts` is explicit that it must not become one. So the platform
  // rail's name lives here. That is not a gap in console-core: every other
  // field on this rail is presentation and lives here too.
  return id === "platform" ? "Platform" : productLabel(id);
}

/**
 * Presentation for a rail, including one this file has never heard of.
 *
 * The fallback is what makes the registry the only place a rail is added: a
 * letter mark from the product's own label, and "Product" for the section
 * heading, which is right for every rail except the platform one — and that
 * one is in the map.
 *
 * `label` is a PARAMETER rather than read from `railLabel` inside, so this can
 * be exercised for a rail id that is not in the registry. `railLabel` would
 * throw on one (`productLabel` looks the id up in `PRODUCTS`), which would
 * make the only testable case the one already in the map above — i.e. not the
 * fallback at all.
 */
export function railPresentation(id: RailId, label: string): RailPresentation {
  return (
    RAIL_PRESENTATION[id] ?? {
      mark: label.charAt(0).toUpperCase(),
      section: "Product",
    }
  );
}

/**
 * Everything the sidebar needs to draw one rail: identity plus presentation.
 *
 * Named `railView` rather than `rail` because `RailMark` takes a prop called
 * `rail`, and a same-named module function would be shadowed inside it.
 */
function railView(id: RailId): RailPresentation & {
  readonly label: string;
  readonly nav: readonly NavEntry[];
} {
  const label = railLabel(id);
  return { ...railPresentation(id, label), label, nav: railNav(id) };
}

/** The rail's chip: real logo where we have one, letter mark otherwise. */
function RailMark({
  rail,
  size,
}: {
  rail: {
    readonly mark: string;
    readonly logo?: string;
    readonly onLight?: boolean;
    readonly label: string;
  };
  size: "sm" | "md";
}) {
  const box = size === "md" ? "h-5 w-5" : "h-4 w-4";
  if (rail.logo) {
    return (
      <span
        aria-hidden="true"
        className={clsx(
          "grid shrink-0 place-items-center overflow-hidden rounded",
          box,
          // Only transparent artwork gets a chip painted behind it. A
          // self-contained icon needs none, and would show the chip as a halo.
          rail.onLight && "bg-white",
        )}
      >
        <Image
          src={rail.logo}
          alt=""
          width={20}
          height={20}
          className={clsx(
            "h-full w-full object-contain",
            rail.onLight && "p-[1px]",
          )}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`grid ${box} shrink-0 place-items-center rounded bg-sidebar-primary ${
        size === "md" ? "text-[10px]" : "text-[9px]"
      } font-bold text-sidebar-primary-foreground`}
    >
      {rail.mark}
    </span>
  );
}

/**
 * Which rail a path belongs to; platform when no product claims it.
 *
 * Matches the CONSOLE path (`/kora/...`), not apps/web's `/admin/apps/kora`.
 * The console does not serve web's paths — see `consolePath`.
 *
 * The `/<product-id>` shape is the convention `routes.ts` declares
 * (`kora.overview` → `/kora`, `mark8ly.overview` → `/mark8ly`) and the one
 * `resolveProductParam` already builds on. Read from `PRODUCT_IDS` rather than
 * spelled out, so a new product's routes reach its rail without an edit here.
 *
 * Not routed through `routeForPath`, unlike `resolveProductParam`: that
 * function is deciding what a page may RENDER and so must agree with the
 * access gate exactly. This one decides which rail is drawn, which grants
 * nothing — and a segment prefix keeps the rail steady on a product path no
 * route id declares, where `routeForPath` would return undefined and drop the
 * operator back to the platform rail on their way to a 404.
 */
export function railFor(pathname: string): RailId {
  const product = PRODUCT_IDS.find(
    (id) => pathname === `/${id}` || pathname.startsWith(`/${id}/`),
  );
  return product ?? "platform";
}


/**
 * Where the collapsed groups are remembered.
 *
 * COLLAPSED groups are stored, not expanded ones, so a group added to the rail
 * later is open the first time an operator sees it — the opposite default
 * would hide new surfaces from exactly the people the rail exists to tell
 * about them, and would do it silently.
 *
 * localStorage rather than a cookie: this is a per-device display preference
 * with no server-side reader, and putting it in a cookie would send it on
 * every request for nothing.
 */
const COLLAPSED_GROUPS_KEY = "console.sidebar.collapsed-groups";

/**
 * Storage is untrusted input — hand-edited, written by an older version, or
 * unreadable altogether (Safari private mode throws on access rather than
 * returning null). Anything that is not a list of strings is treated as "no
 * preference recorded", which fails open: every group visible.
 */
function readCollapsedGroups(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsedGroups(names: readonly string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(names));
  } catch {
    // A full or disabled store costs the operator a preference, never a rail.
  }
}

/**
 * The collapsed set, persisted, with one rule layered on top: the group
 * holding the route you are on is opened.
 *
 * A rail that hides where you are is worse than a long rail — you lose the one
 * landmark that tells you which part of the console you are in. So the active
 * group is dropped from the collapsed set when it becomes active, rather than
 * being forced open at render time: forcing it at render would make the toggle
 * button inert on that one group, which is a worse lie than a long list.
 */
function useCollapsedGroups(activeGroup: string | null) {
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  // Read in an effect, not in the initial state: this component is
  // server-rendered, `window` does not exist there, and seeding state from
  // storage would hydrate a different tree than the server sent.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsedGroups());
    setLoaded(true);
  }, []);

  useEffect(() => {
    // Never write before the first read, or the empty initial state would
    // erase the stored preference on every mount.
    if (!loaded) return;
    writeCollapsedGroups(collapsed);
  }, [collapsed, loaded]);

  useEffect(() => {
    if (activeGroup === null) return;
    setCollapsed((previous) =>
      previous.includes(activeGroup) ? previous.filter((name) => name !== activeGroup) : previous,
    );
  }, [activeGroup]);

  const toggle = useCallback((name: string) => {
    setCollapsed((previous) =>
      previous.includes(name)
        ? previous.filter((entry) => entry !== name)
        : [...previous, name],
    );
  }, []);

  return { collapsed, toggle };
}

/** The name of the group holding the current route, or null. */
export function activeGroupName(nav: readonly NavEntry[], pathname: string): string | null {
  for (const entry of nav) {
    if (!isNavGroup(entry)) continue;
    if (entry.items.some((item) => isRouteActive(pathname, item.route, "console"))) {
      return entry.name;
    }
  }
  return null;
}

/**
 * One collapsible group.
 *
 * A real `<button>` with `aria-expanded` and `aria-controls`, not a div with a
 * click handler and a `role`: the console has already had orphan-`role` ARIA
 * violations flagged (`role="tab"` on links with no tablist parent), and the
 * fix for that was to use the element whose semantics are already right rather
 * than to describe the wrong element more carefully. A button is focusable,
 * activates on Enter and Space, and announces its expanded state — none of
 * which has to be reimplemented here.
 *
 * The panel is hidden with the `hidden` attribute rather than unmounted or
 * merely visually hidden, so a collapsed group's links leave the tab order and
 * the accessibility tree together.
 */
function NavGroupSection({
  group,
  pathname,
  railRoutes,
  open,
  onToggle,
}: {
  group: NavGroup;
  pathname: string;
  /** Passed straight through to `NavLink` — see its own prop doc. */
  railRoutes: readonly RouteId[];
  open: boolean;
  onToggle: (name: string) => void;
}) {
  const panelId = useId();
  return (
    <div className="pt-4 first:pt-0">
      <button
        type="button"
        onClick={() => onToggle(group.name)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={clsx(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span>{group.name}</span>
      </button>
      <div id={panelId} hidden={!open} className="space-y-0.5 pt-1">
        {group.items.map((item) => (
          <NavLink
            key={item.name}
            entry={item}
            pathname={pathname}
            railRoutes={railRoutes}
          />
        ))}
      </div>
    </div>
  );
}

function NavLink({
  entry,
  pathname,
  railRoutes,
}: {
  entry: NavEntry;
  pathname: string;
  /**
   * Every route the CURRENT rail renders, groups flattened away. Threaded down
   * from `Sidebar` rather than derived here, because "most specific wins" is a
   * statement about the entries an operator can see side by side, and a link
   * cannot know its own rail's other entries.
   */
  railRoutes: readonly RouteId[];
}) {
  if (isNavGroup(entry)) {
    // Groups render through `NavGroupSection`, which needs the collapse state
    // the sidebar owns. Reaching one here means a caller passed a group where
    // an item was expected.
    return null;
  }

  // Not `isRouteActive`: a rail entry whose target is a prefix of a sibling's
  // (`platform.secrets` under `platform.secretsReviews`) is active on the
  // sibling's pages too, and both rendered `aria-current="page"` at once.
  const active = isMostSpecificActiveRoute(
    pathname,
    entry.route,
    railRoutes,
    "console",
  );

  // Not built here yet. Deliberately NOT a link to apps/web: the old admin is
  // being retired, and pointing at it would make the console a shell around
  // the app it replaces. Shown as pending so the rail still describes the
  // intended IA without offering navigation that does not work.
  if (isPending(entry.route)) {
    return (
      <span
        aria-disabled="true"
        title={`${entry.name} — not built in the console yet`}
        className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground/35"
      >
        <NavIcon name={entry.icon} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
        <span className="ml-auto shrink-0 text-[9px] font-medium uppercase tracking-wider text-sidebar-foreground/30">
          soon
        </span>
      </span>
    );
  }

  return (
    <Link
      href={consolePath(entry.route)}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <NavIcon name={entry.icon} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{entry.name}</span>
    </Link>
  );
}

function RailSwitcher({
  current,
  onSelect,
}: {
  current: RailId;
  onSelect: (key: RailId) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const currentRail = railView(current);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <RailMark rail={currentRail} size="md" />
        <span className="truncate text-[13px] font-semibold text-sidebar-foreground">
          {currentRail.label}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40"
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Switch context"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-sidebar-border bg-sidebar shadow-lg"
        >
          {RAIL_IDS.map((key) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelect(key);
                setOpen(false);
              }}
              className={clsx(
                "flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] transition-colors",
                key === current
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <RailMark rail={railView(key)} size="sm" />
              <span className="truncate">{railLabel(key)}</span>
              {key === current ? (
                <Check aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConsoleSidebar({
  capabilities = [],
  enforceCapabilities = false,
}: {
  /** The operator's held capabilities, from the layout. */
  capabilities?: readonly string[];
  /** False on the legacy provider, which carries no capability claims — the
   *  rail then renders whole, the same contract the palette's `visibleTo`
   *  has. Defaulted so an existing render call is unchanged. */
  enforceCapabilities?: boolean;
}) {
  const pathname = usePathname();
  // The switcher changes CONTEXT, not location: selecting a rail does not
  // navigate. That was first written when every surface in every rail was
  // still served by apps/web and selecting one would have ejected the
  // operator from the console. Several rails now have console pages, but the
  // behaviour stands for a second reason — a rail's first entry is not
  // reliably somewhere an operator wants to land, and the platform rail's is
  // the console root. Instead the choice is local, and the route you are
  // actually on always wins when it changes.
  const [selected, setSelected] = useState<RailId | null>(null);
  const fromPath = railFor(pathname);

  useEffect(() => {
    setSelected(null);
  }, [pathname]);

  const railKey = selected ?? fromPath;
  const current = useMemo(() => railView(railKey), [railKey]);
  // #263: a surface the operator cannot reach is not offered. The refusal
  // itself is the layout's `capabilityForPath` gate — hiding alone would be
  // presentation, and #244 decided "hidden AND enforced".
  const nav = useMemo(
    () => visibleNav(current.nav, capabilities, enforceCapabilities),
    [current.nav, capabilities, enforceCapabilities],
  );

  // Group names are unique across the rails, so one stored set serves all of
  // them; a rail whose nav is flat (Kora's and Mark8ly's) never contributes to
  // it at all.
  const { collapsed, toggle } = useCollapsedGroups(activeGroupName(nav, pathname));

  // `navItems` rather than a local flattener: `lib/search.ts` already walks the
  // rails this way, and a second walker that stopped at groups would report an
  // empty rail here — every entry would then look "most specific" and nothing
  // would be narrowed.
  const railRoutes = useMemo(
    () => navItems(nav).map((item) => item.route),
    [nav],
  );

  return (
    <div className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="p-3">
        <RailSwitcher current={railKey} onSelect={setSelected} />
      </div>

      <nav
        // `sidebar-scroll` styles the scrollbar to the rail rather than
        // leaving the browser default, which paints a pale bar down a dark
        // sidebar. See globals.css — it is theme-aware through the same
        // sidebar tokens everything else here uses.
        className="sidebar-scroll flex-1 overflow-y-auto px-3 pb-4"
        aria-label={`${current.label} navigation`}
      >
        {/* A flat rail still gets its section label; a grouped one carries its
            own, so this only renders when the nav has no groups of its own. */}
        {nav.some(isNavGroup) ? null : (
          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/50">
            {current.section}
          </p>
        )}
        <div className="space-y-0.5">
          {nav.map((entry) =>
            isNavGroup(entry) ? (
              <NavGroupSection
                key={entry.name}
                group={entry}
                pathname={pathname}
                railRoutes={railRoutes}
                open={!collapsed.includes(entry.name)}
                onToggle={toggle}
              />
            ) : (
              <NavLink
                key={entry.name}
                entry={entry}
                pathname={pathname}
                railRoutes={railRoutes}
              />
            ),
          )}
        </div>
      </nav>
    </div>
  );
}
