"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ChevronsUpDown, ExternalLink } from "lucide-react";
import {
  isHostedByWeb,
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
const RAILS = {
  platform: { label: "Platform", mark: "T", nav: platformNav, section: "Operate" },
  kora: { label: "Kora", mark: "K", nav: koraNav, section: "Product" },
} as const;

type RailKey = keyof typeof RAILS;

/** Which rail a path belongs to. Kora's routes are the only product ones. */
export function railFor(pathname: string): RailKey {
  return pathname.startsWith("/admin/apps/kora") ? "kora" : "platform";
}

const WEB_ORIGIN = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3002";

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
  // Surfaces the console does not host yet must open on the web origin.
  // Linking them in-app would route to a page that does not exist here.
  const external = isHostedByWeb(entry.route);
  const href = external ? `${WEB_ORIGIN}${webPath(entry.route)}` : webPath(entry.route);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <NavIcon name={entry.icon} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{entry.name}</span>
      {external ? (
        <ExternalLink
          aria-label="opens in apps/web"
          className="ml-auto h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50"
        />
      ) : null}
    </Link>
  );
}

export function ConsoleSidebar() {
  const pathname = usePathname();
  const rail = RAILS[railFor(pathname)];

  return (
    <div className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="p-3">
        {/* Shows which rail you are in. Not yet a switcher — there are two
            rails and only one is reachable in-app, so a menu would offer a
            choice that does not exist. It becomes one as products migrate. */}
        <div className="flex items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2">
          <span
            aria-hidden="true"
            className="grid h-5 w-5 shrink-0 place-items-center rounded bg-sidebar-primary text-[10px] font-bold text-sidebar-primary-foreground"
          >
            {rail.mark}
          </span>
          <span className="truncate text-[13px] font-semibold text-sidebar-foreground">
            {rail.label}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="ml-auto h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40"
          />
        </div>
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
