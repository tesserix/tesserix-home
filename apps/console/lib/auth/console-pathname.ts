/**
 * The request header middleware uses to hand the console layout the path it is
 * rendering (#262).
 *
 * A Next.js server layout receives no pathname — there is no prop for it and
 * no API to read one — so the capability gate has no other way to learn which
 * surface a request is for. Middleware sets it on the REQUEST headers, so it
 * travels into the render and is never sent to the browser.
 *
 * Its own module so the setter and the reader import one constant. A string
 * literal spelled twice is the kind of drift that fails open here: the layout
 * would read `undefined`, resolve to the entry capability, and quietly stop
 * gating anything — which looks exactly like everything working.
 */
export const CONSOLE_PATHNAME_HEADER = "x-console-pathname";

/**
 * The pathname the capability gate must be asked about.
 *
 * # The two-strings problem
 *
 * `request.nextUrl.pathname` is not percent-decoded, but Next's router matches
 * the RAW pathname against the route tree and then hands the page the DECODED
 * param. So the gate and the page resolved the same request from two different
 * strings: `capabilityForPath` matches console route paths literally, so
 * `/%6Dark8ly` matched no route and fell back to the console entry capability
 * (`read`, the ticket every operator who can reach the console holds), while
 * `[product]` matched the raw segment and gave `resolveProductParam` the
 * decoded `"mark8ly"` — which renders Mark8ly's overview. Every console route
 * before `[product]` had a static first segment, so an encoded path simply
 * 404'd at the router and the disagreement had nowhere to land.
 *
 * Normalising HERE rather than inside `capabilityForPath`: middleware is the
 * only place in the console that holds an un-decoded path. Every other caller
 * of `capabilityForPath`/`routeForPath` — `resolveProductParam`,
 * `resolveEntitySurface` — builds its argument from an already-decoded router
 * param, so decoding inside `console-core` would decode some inputs twice,
 * which is the same class of bug in the other direction. `console-core` is
 * also a pure data package the web and mobile apps consume, and neither has
 * this header or this gate.
 *
 * # Per segment, decoded exactly once
 *
 * Each segment is decoded on its own so a `%2F` cannot invent path structure
 * the router never saw — the router splits the raw pathname, so `a%2Fb` is one
 * segment to it and must stay one segment here.
 *
 * Once, never to a fixed point: `%2525` is `%25` after the router's single
 * decode, and `%25` is what the page sees. Decoding again would produce a
 * third string neither layer ever resolves.
 *
 * # A segment this cannot safely decode is left exactly as it arrived
 *
 * Three cases. `decodeURIComponent` throws on malformed input (a bare `%`). A
 * segment decoding to contain `/` would fabricate a segment boundary. A
 * segment decoding to contain NUL cannot be carried on the refusal path: the
 * gate passes this string to `recordDeniedAttempt` as `target`, and from there
 * it reaches an `INSERT` into `console_audit_log`, whose Postgres `text`
 * column cannot hold one.
 *
 * Leaving that one segment raw is both the fail-closed answer and the smallest
 * one: raw is exactly what the gate sees today, so the capability it resolves
 * cannot come out weaker than it already does. Dropping the whole
 * normalisation on one bad segment would be weaker — the segments around it
 * still decode, so `/%70latform/crm/%` resolves to `/platform/crm/…` and
 * demands `crm` where the raw path demands only `read`.
 *
 * A raw segment directly under a route declared `exact` (a product root) still
 * lands on no route and still falls back to `read`: `/mark8ly/%` matches
 * neither `/mark8ly` (exact) nor `/mark8ly/tenants`. That is today's answer
 * unchanged, and it is not an exposure — the router cannot decode `%` into an
 * `[entity]` param either, so no page renders for it.
 *
 * # Why this can only ever raise the requirement
 *
 * `routeForPath` takes the LONGEST console route path that is a segment-prefix
 * of the request path, and no console route path contains a `%`
 * (`console-pathname.test.ts` asserts this over the whole table). So every
 * segment of a route that matched the RAW path is `%`-free, decodes to itself,
 * and still matches after normalisation. Normalisation can only add matches,
 * never remove one — the result is the same route or a more specific one, and
 * a path that matched nothing still falls back to `read`, the weakest
 * capability there is.
 *
 * That covers `isShellRoute` too, which is the one place `capabilityForPath`
 * answers `read` for a path that DID match. Newly resolving to a shell route
 * could only be a downgrade if a shell route were the longer match under a
 * stricter one. The console's two shell routes are `/` — which can never be
 * the longer match, being the shortest path there is — and
 * `/platform/profile`, which nests under no route at all, there being no
 * `/platform` entry. The same test asserts both, and asserts more generally
 * that no route nested under another declares a different capability.
 */
export function consoleGatePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      // Cheap and, more to the point, exact: a segment with no `%` is its own
      // decoding, so this is not an optimisation that could change an answer.
      if (!segment.includes("%")) return segment;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return segment;
      }
      if (decoded.includes("/") || decoded.includes("\u0000")) return segment;
      return decoded;
    })
    .join("/");
}
