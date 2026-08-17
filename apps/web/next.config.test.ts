import { stringifyQuery } from "next/dist/server/server-route-utils";
import { formatUrl } from "next/dist/shared/lib/router/utils/format-url";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

async function cspDirectives(): Promise<Record<string, string>> {
  const headerGroups = await nextConfig.headers!();
  const csp = headerGroups
    .flatMap((group) => group.headers)
    .find((header) => header.key === "Content-Security-Policy");

  return Object.fromEntries(
    csp!.value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

/**
 * Resolve a request URL through the config's `redirects()` the way Next does.
 *
 * Deliberately Next's own `getPathMatch` + `prepareDestination` rather than a
 * hand-rolled matcher: the question these tests answer is "what will Next do
 * with this", and a reimplementation can only ever assert what the test author
 * already believed. Query-string preservation in particular is behaviour of
 * `prepareDestination`, not of anything in this repo.
 *
 * THE LAST THREE LINES MIRROR `resolve-routes.ts`'s redirect branch EXACTLY,
 * and it is worth saying why, because this is where the previous version of
 * this helper was wrong (#139).
 *
 * It called `prepareDestination({appendParamsToQuery: true})` and formatted the
 * result directly. That is the REWRITE path, not the redirect path. Next's
 * redirect branch passes `appendParamsToQuery: false` and then rebuilds
 * `search` from the merged query — because `prepareDestination` merges
 * `{...requestQuery, ...destinationQuery}` into `parsedDestination.query` but
 * leaves `parsedDestination.search` holding only the destination's OWN query
 * string, and `formatUrl` prefers `search` when it is set.
 *
 * The two agreed as long as no destination had a query string of its own — the
 * #199 destinations did not. The moment one does (`?source=mark8ly`), the old
 * helper reported the request's params as DROPPED when Next in fact carries
 * them. A test harness that answers the opposite of production about the one
 * behaviour it exists to check is worse than no harness, so it is fixed here
 * rather than worked around.
 *
 * Returns the absolute URL the browser is sent to, or null when nothing matches.
 */
async function resolveRedirect(url: string): Promise<string | null> {
  const [pathname, search = ""] = url.split("?");
  const query = Object.fromEntries(new URLSearchParams(search));

  for (const redirect of await nextConfig.redirects!()) {
    const match = getPathMatch(redirect.source, {
      removeUnnamedParams: true,
      strict: true,
    })(pathname);
    if (!match) continue;

    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: redirect.destination,
      params: match,
      query,
    });
    // `req` is only read for `initQuery` request metadata, which decides
    // whether a value gets percent-encoded. There is no request here, and a
    // plain object is what an unannotated one degrades to.
    const merged = stringifyQuery({} as never, parsedDestination.query);
    delete (parsedDestination as { query?: unknown }).query;
    parsedDestination.search = merged ? `?${merged}` : "";
    return formatUrl(parsedDestination);
  }
  return null;
}

describe("the admin surfaces #199 and #207 retired are served, not redirected", () => {
  // Inverted from the assertions #199 and #207 left here. Nothing under
  // /admin/ is retired until the console app is complete, so these six pages
  // exist again and their redirects are gone. Asserting "no redirect matches"
  // is the guard that rule wants: re-adding one for any of these is exactly
  // the retirement it forbids, and it fails here rather than in review.
  //
  // The console's own surfaces are untouched. Both systems serve the same
  // work from their own origins and read the same API.
  it.each([
    ["the ticket queue", "/admin/platform-tickets"],
    ["a ticket detail page", "/admin/platform-tickets/abc-123"],
    ["support analytics", "/admin/analytics/support"],
    ["mark8ly's audit log", "/admin/apps/mark8ly/audit-logs"],
    ["kora's audit trail", "/admin/apps/kora/audit"],
    ["homechef's audit log", "/admin/apps/homechef/audit-logs"],
  ])("serves %s", async (_label, path) => {
    expect(await resolveRedirect(path)).toBeNull();
  });

  it("serves them with their own query params too", async () => {
    // A redirect added with a query-bearing source would slip past a
    // bare-path assertion. These are the params the restored pages read.
    expect(
      await resolveRedirect("/admin/platform-tickets?status=open&priority=urgent"),
    ).toBeNull();
    expect(
      await resolveRedirect("/admin/apps/mark8ly/audit-logs?severity=critical"),
    ).toBeNull();
    expect(
      await resolveRedirect("/admin/apps/kora/audit?target_id=f-1&offset=50"),
    ).toBeNull();
  });

  it("leaves live chat alone", async () => {
    // #197 owns /admin/support/live-chat and it never had a redirect.
    expect(await resolveRedirect("/admin/support/live-chat")).toBeNull();
  });

  it("does not swallow the rest of the admin", async () => {
    // Guards the guard: a resolver that returned null for everything would
    // pass every assertion above. The non-admin redirects that predate this
    // work still resolve, so the resolver is doing real matching.
    expect(await resolveRedirect("/admin/dashboard")).toBeNull();
    expect(await resolveRedirect("/admin/apps/kora/foods")).toBeNull();
    expect(await resolveRedirect("/launch")).toBe("/products");
  });
});

describe("content security policy", () => {
  it("allows the self-hosted OpenPanel tracking script to load", async () => {
    expect((await cspDirectives())["script-src"]).toContain(
      "https://analytics.tesserix.app",
    );
  });

  it("allows events to be posted to the OpenPanel API", async () => {
    expect((await cspDirectives())["connect-src"]).toContain(
      "https://*.tesserix.app",
    );
  });
});
