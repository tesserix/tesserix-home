/**
 * Resolving a request path to the surface that owns it, and to the capability
 * that guards it (#262, RBAC R2).
 *
 * # Why this is not a second matcher
 *
 * #262's central requirement is that enforcement reads the SAME route table
 * the navigation reads — "two sources of truth for what does this surface
 * require is the failure this design exists to avoid, and is roughly how the
 * current split between `routeCapability` and the sidebar arose."
 *
 * So this module owns no matching rules of its own. It is `isRouteActive`
 * (segment boundaries, `exact` for product roots) plus the most-specific-wins
 * narrowing `isMostSpecificActiveRoute` already applies for highlighting —
 * asked of every route rather than of one rail's candidates, because access is
 * a question about the whole table and not about what a rail renders side by
 * side.
 *
 * # A detail page is guarded by its surface
 *
 * `/platform/crm/<id>` is not its own entry. Falling through to "no route
 * matched" for it would leave every record page in the console ungated by
 * virtue of not being listed, so the prefix match is load-bearing here in a
 * way it is not for highlighting.
 */
// Type-only, for the reason routes.ts states at its own import: `Capability`
// is a contract with Zitadel, and importing the VALUE would make this module a
// runtime dependency of platform-auth.
import type { Capability } from "@tesserix/platform-auth";
import {
  ROUTE_IDS,
  consolePath,
  isRouteActive,
  routeCapability,
  type RouteId,
} from "./routes";
import { isNavGroup, type NavEntry } from "./nav";

/**
 * The literal value of `CONSOLE_ENTRY_CAPABILITY`, written out rather than
 * imported — the same decision `routeCapability` documents, and for the same
 * reason: importing the value would turn a type-only dependency into a runtime
 * one. `capabilities.ts` treats these strings as immutable, so it cannot rot.
 */
const ENTRY_CAPABILITY: Capability = "read";

/**
 * The surface a path belongs to, or `undefined` when no surface claims it.
 *
 * Most specific wins: `/platform/secrets/reviews` belongs to the reviews
 * queue, not to the inventory it nests under.
 */
export function routeForPath(currentPath: string): RouteId | undefined {
  let best: { id: RouteId; length: number } | undefined;
  for (const id of ROUTE_IDS) {
    if (!isRouteActive(currentPath, id, "console")) continue;
    // `consolePath` resolves the same `console ?? mobile` fallback
    // `isRouteActive` matched against, so the length compared here is the
    // length of the string that actually matched.
    const length = consolePath(id).length;
    if (!best || length > best.length) best = { id, length };
  }
  return best?.id;
}

/**
 * The capability required to reach `currentPath`.
 *
 * An undeclared path falls back to the console ENTRY capability rather than to
 * a refusal. Refusing would 404 every page that is not a rail entry until
 * someone declared it — an outage generator discovered in production — and the
 * fallback is exactly today's behaviour, so it cannot make anything less safe
 * than it already is. What it does is make declared surfaces safer.
 */
/**
 * The console's landing page. `safeReturnPath` sends every fresh sign-in here.
 */
const CONSOLE_HOME = "/";

export function capabilityForPath(currentPath: string): Capability {
  // THE SHELL IS NOT A SURFACE, and the landing page is the shell.
  //
  // `platform.dashboard` declares `platform` and its console target is `/`, so
  // without this an operator holding `crm` and `support` but not `platform`
  // signed in — `safeReturnPath` defaults to `/` — and got a 404. No shell, no
  // rail, no route to the two surfaces they did hold. That is #266's R6.4,
  // "the case most likely to be missed", and worse than it anticipated: it
  // strikes operators who hold surfaces, not only those who hold none.
  //
  // Fixed HERE rather than by putting `read` on the route, which was the first
  // attempt and was wrong: `routes.test.ts` holds an invariant from #261 that
  // NO route may resolve to the entry ticket, because a surface gated on the
  // ticket every operator already holds is not gated at all. That rule is
  // about surfaces. `/` is not one — it renders the estate map and the tools
  // directory, which is orientation, and #261's own note on `read` says it
  // "grants the shell and home".
  //
  // The rail entry for Dashboard still declares `platform` and is still hidden
  // from an operator without it. That is deliberate: they land on the shell,
  // and the rail offers them only what they can reach.
  if (currentPath === CONSOLE_HOME || currentPath === "") return ENTRY_CAPABILITY;

  const id = routeForPath(currentPath);
  return id ? routeCapability(id) : ENTRY_CAPABILITY;
}

/**
 * A rail with every surface the operator does not hold removed (#263, R3).
 *
 * Reads the SAME `routeCapability` the access gate reads — this is the "hidden
 * AND enforced" half of #244's decision, and the two halves disagreeing is the
 * failure it names. Hiding alone is presentation; `capabilityForPath` is the
 * control.
 *
 * A group whose every item is filtered away is dropped entirely, rather than
 * rendered as a heading with nothing under it — an empty group reads as a
 * loading failure, which is the same argument `toolsInGroup`'s "leaves no
 * group empty" test makes for the tools directory.
 *
 * `enforce` mirrors `visibleTo` in apps/console/lib/search.ts: the legacy
 * provider carries no capability claims at all, so filtering on an absent
 * claim would empty the rail for every operator. When it is false the rail
 * passes through untouched — the same "off means unchanged" contract the
 * palette already has, so the two surfaces cannot disagree about whether
 * enforcement is on.
 */
export function visibleNav(
  nav: readonly NavEntry[],
  held: readonly string[] | undefined,
  enforce: boolean,
): NavEntry[] {
  if (!enforce) return [...nav];
  // Fails closed on an absent claims list, for the reason `visibleTo` states:
  // a bug that drops the list must not silently turn into full access.
  const heldSet = new Set(held ?? []);
  const permitted = (route: RouteId) => heldSet.has(routeCapability(route));

  return nav.flatMap<NavEntry>((entry) => {
    if (!isNavGroup(entry)) return permitted(entry.route) ? [entry] : [];
    const items = entry.items.filter((item) => permitted(item.route));
    return items.length > 0 ? [{ ...entry, items }] : [];
  });
}
