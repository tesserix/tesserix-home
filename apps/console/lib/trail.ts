import { consolePath, isPending, ROUTE_IDS, type RouteId } from "@tesserix/console-core";
import { routeSegmentLabel } from "@/lib/search";

export interface TrailCrumb {
  readonly label: string;
  readonly href: string;
}

/**
 * Console path -> route id, for built (non-pending) routes only.
 *
 * Pending routes are excluded here rather than filtered later: a crumb
 * pointing at a pending surface would 404, and the palette applies the same
 * rule to its own results — better absent than broken.
 *
 * Module-scope const: ROUTE_IDS is static data, so this map is a pure
 * derivation, not mutable state, and is safe to memoise once.
 */
const PATH_TO_ROUTE_ID: ReadonlyMap<string, RouteId> = new Map(
  ROUTE_IDS.filter((id) => !isPending(id)).map((id) => [consolePath(id), id]),
);

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Labels a route id by its leaf segment, e.g. `platform.tickets` -> "Tickets".
 * The ancestor crumb only needs the leaf: the header trail is read next to
 * the page's own title, not in the flat, disambiguated list the palette
 * shows, so it does not need the domain prefix the palette's fuller label
 * carries.
 */
function labelFor(id: RouteId): string {
  const segments = id.split(".");
  const leaf = segments[segments.length - 1] ?? id;
  return routeSegmentLabel(leaf);
}

/**
 * The ancestor crumbs for a pathname, shallowest first, excluding the
 * pathname's own leaf — the page renders that itself as its title. See
 * `header-trail.tsx` for why the split between header and page exists.
 */
export function ancestorTrail(pathname: string): TrailCrumb[] {
  const normalized = withoutTrailingSlash(pathname);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  const crumbs: TrailCrumb[] = [];
  // Walk prefixes shortest-first, excluding the full path itself (the last
  // index), which yields ancestors in shallowest-first order directly.
  for (let depth = 1; depth < segments.length; depth += 1) {
    const prefix = `/${segments.slice(0, depth).join("/")}`;
    const routeId = PATH_TO_ROUTE_ID.get(prefix);
    if (routeId !== undefined) {
      crumbs.push({ label: labelFor(routeId), href: prefix });
    }
  }
  return crumbs;
}
