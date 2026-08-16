"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ancestorTrail } from "@/lib/trail";

/**
 * The header's ancestor breadcrumb — the fix for the bug where a long ticket
 * thread scrolls the page's own breadcrumb out of view, leaving no visible
 * way back to the queue. The sticky header carries the ANCESTORS so the way
 * back stays on screen; the page keeps rendering its own title as the leaf.
 *
 * Deliberately derived from the pathname rather than published up from the
 * page through a context + effect: the header is a client component in the
 * layout and pages are server components passed as `children`, so a
 * publish-up shape would flicker on navigation, go stale when an effect does
 * not fire, and fight RSC. Reading the pathname keeps this self-contained.
 *
 * The bar never renders the leaf and the page never renders the ancestors,
 * so nothing appears twice — see `lib/trail.ts` for the split.
 */
export function HeaderTrail(): React.JSX.Element | null {
  const pathname = usePathname();
  const crumbs = ancestorTrail(pathname);

  if (crumbs.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 truncate text-sm">
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5 truncate">
          <Link
            href={crumb.href}
            className="truncate text-muted-foreground transition-colors hover:text-foreground"
          >
            {crumb.label}
          </Link>
          <span aria-hidden="true" className="text-muted-foreground/50">
            /
          </span>
        </span>
      ))}
    </nav>
  );
}
