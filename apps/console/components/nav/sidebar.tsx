"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  isPending,
  isNavGroup,
  isRouteActive,
  koraNav,
  platformNav,
  webPath,
  type NavEntry,
} from "@tesserix/console-core";
import { NavIcon } from "./icon";

// The console's rails. Platform is the default — it is the context the
// console's own home page serves — and a product rail takes over inside that
// product's routes. apps/web calls this the RailContext; the console needs
// only the two it can actually render today.
// `logo` wins over `mark` when present, and `onLight` says whether the artwork
// needs a background painted for it.
//
// The two marks differ in kind, not just in image. Tesserix is navy on
// TRANSPARENT: it needs a light chip in both themes, or it vanishes against a
// dark sidebar. Kora's app icon is SELF-CONTAINED — its own dark gradient,
// already a rounded square — so painting anything behind it would show as a
// halo. Hence the flag rather than one shared wrapper.
const RAILS = {
  platform: {
    label: "Platform",
    mark: "T",
    logo: "/tesserix-mark.png",
    onLight: true,
    nav: platformNav,
    section: "Operate",
  },
  kora: {
    label: "Kora",
    mark: "K",
    logo: "/kora-mark.png",
    onLight: false,
    nav: koraNav,
    section: "Product",
  },
} as const;

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

type RailKey = keyof typeof RAILS;

/** Which rail a path belongs to. Kora's routes are the only product ones. */
export function railFor(pathname: string): RailKey {
  return pathname.startsWith("/admin/apps/kora") ? "kora" : "platform";
}


function NavLink({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  if (isNavGroup(entry)) {
    return (
      <div className="pt-4 first:pt-0">
        <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/50">
          {entry.name}
        </p>
        <div className="space-y-0.5">
          {entry.items.map((item) => (
            <NavLink key={item.name} entry={item} pathname={pathname} />
          ))}
        </div>
      </div>
    );
  }

  const active = isRouteActive(pathname, entry.route, "web");

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
      href={webPath(entry.route)}
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
  current: RailKey;
  onSelect: (key: RailKey) => void;
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

  const rail = RAILS[current];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <RailMark rail={rail} size="md" />
        <span className="truncate text-[13px] font-semibold text-sidebar-foreground">
          {rail.label}
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
          {(Object.keys(RAILS) as RailKey[]).map((key) => (
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
              <RailMark rail={RAILS[key]} size="sm" />
              <span className="truncate">{RAILS[key].label}</span>
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

export function ConsoleSidebar() {
  const pathname = usePathname();
  // The switcher changes CONTEXT, not location. Every surface in both rails is
  // still served by apps/web, so navigating on select would eject the operator
  // from the console just to look at a rail. Instead the choice is local, and
  // the route you are actually on always wins when it changes.
  const [selected, setSelected] = useState<RailKey | null>(null);
  const fromPath = railFor(pathname);

  useEffect(() => {
    setSelected(null);
  }, [pathname]);

  const railKey = selected ?? fromPath;
  const rail = RAILS[railKey];

  return (
    <div className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="p-3">
        <RailSwitcher current={railKey} onSelect={setSelected} />
      </div>

      <nav
        className="flex-1 overflow-y-auto px-3 pb-4"
        aria-label={`${rail.label} navigation`}
      >
        {/* A flat rail still gets its section label; a grouped one carries its
            own, so this only renders when the nav has no groups of its own. */}
        {rail.nav.some(isNavGroup) ? null : (
          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/50">
            {rail.section}
          </p>
        )}
        <div className="space-y-0.5">
          {rail.nav.map((entry) => (
            <NavLink key={entry.name} entry={entry} pathname={pathname} />
          ))}
        </div>
      </nav>
    </div>
  );
}
