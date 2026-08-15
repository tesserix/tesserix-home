"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  isNavGroup,
  koraNav,
  webPath,
  isRouteActive,
  type NavEntry,
} from "@tesserix/console-core";
import { NavIcon } from "./icon";

// The console's sidebar is a single flat panel: it maps `koraNav` straight
// through `webPath`/`isRouteActive`/`NavIcon`. Unlike apps/web's AdminSidebar
// there is no product rail (the console is single-product), no
// `getActiveContext`, and no `getSecondaryNav` — those exist to switch
// between products inside one shared shell, which this app doesn't need.
function NavLink({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  if (isNavGroup(entry)) {
    // koraNav has no groups today; this keeps the component well-typed if
    // one is ever added, without reintroducing collapsible-group state.
    return (
      <div>
        <div className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-sidebar-foreground/70">
          <NavIcon name={entry.icon} className="h-4 w-4" />
          {entry.name}
        </div>
        <div className="ml-4 space-y-0.5 border-l border-sidebar-border pl-3">
          {entry.items.map((item) => (
            <NavLink key={item.name} entry={item} pathname={pathname} />
          ))}
        </div>
      </div>
    );
  }

  const href = webPath(entry.route);
  const active = isRouteActive(pathname, entry.route, "web");

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      <NavIcon name={entry.icon} className="h-4 w-4" />
      {entry.name}
    </Link>
  );
}

export function ConsoleSidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-16 items-center gap-2.5 px-4">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-md bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground"
        >
          K
        </span>
        <h2 className="text-sm font-semibold text-sidebar-foreground">Kora</h2>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 pb-4" aria-label="Kora">
        {/* A section label, even with one section: it names what the list is,
            and it is where further groups attach as products migrate in. */}
        <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/50">
          Product
        </p>
        {koraNav.map((entry) => (
          <NavLink key={entry.name} entry={entry} pathname={pathname} />
        ))}
      </nav>
    </div>
  );
}
