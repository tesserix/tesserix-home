import { stringifyQuery } from "next/dist/server/server-route-utils";
import { formatUrl } from "next/dist/shared/lib/router/utils/format-url";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { describe, expect, it } from "vitest";
import nextConfig, { CONSOLE_ORIGIN } from "./next.config";

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

describe("the retired support surfaces redirect to the console", () => {
  it("sends the ticket queue to the console", async () => {
    expect(await resolveRedirect("/admin/platform-tickets")).toBe(
      `${CONSOLE_ORIGIN}/platform/tickets`,
    );
  });

  it("carries the queue's filters across", async () => {
    // The console's queue reads all three (`readQueueFilters`). A redirect that
    // dropped them would silently widen a filtered bookmark to the whole
    // estate — which looks like it worked.
    expect(
      await resolveRedirect(
        "/admin/platform-tickets?status=open&priority=urgent&product=mark8ly",
      ),
    ).toBe(
      `${CONSOLE_ORIGIN}/platform/tickets?status=open&priority=urgent&product=mark8ly`,
    );
  });

  it("keeps the ticket id when redirecting a detail page", async () => {
    expect(await resolveRedirect("/admin/platform-tickets/abc-123")).toBe(
      `${CONSOLE_ORIGIN}/platform/tickets/abc-123`,
    );
  });

  it("does not repeat a consumed path param in the query string", async () => {
    // `:id` is spent on the path, so `appendParamsToQuery` must not also emit
    // `?id=`. Guards a destination that forgot the `:id` placeholder: that
    // would still "pass" a laxer assertion by smuggling the id into the query.
    expect(await resolveRedirect("/admin/platform-tickets/abc-123?status=open")).toBe(
      `${CONSOLE_ORIGIN}/platform/tickets/abc-123?status=open`,
    );
  });

  it("sends support analytics to the queue, which now hosts it as a tab", async () => {
    expect(await resolveRedirect("/admin/analytics/support")).toBe(
      `${CONSOLE_ORIGIN}/platform/tickets`,
    );
  });

  it("leaves live chat alone", async () => {
    // #197 owns /admin/support/live-chat and it has no console equivalent.
    // Redirecting it would take a working surface offline.
    expect(await resolveRedirect("/admin/support/live-chat")).toBeNull();
  });

  it("does not swallow the rest of the admin", async () => {
    // Guards the guard, twice over. A resolver that returned the first entry
    // regardless of the path would pass every assertion above, and a `source`
    // written as a prefix rather than an exact path would retire surfaces
    // nobody meant to touch.
    expect(await resolveRedirect("/admin/dashboard")).toBeNull();
    expect(await resolveRedirect("/admin/platform-announcements")).toBeNull();
  });
});

describe("the three product audit pages redirect to the estate timeline", () => {
  // #139 merged them into one console surface. Each redirect carries
  // `?source=` because these were PRODUCT-SCOPED pages: landing unfiltered
  // would widen "Kora's audit trail" into "everything anyone has ever done",
  // which is the same silent widening the ticket-queue filter test guards.
  it.each([
    ["/admin/apps/mark8ly/audit-logs", "mark8ly"],
    ["/admin/apps/kora/audit", "kora"],
    ["/admin/apps/homechef/audit-logs", "homechef"],
  ])("sends %s to the console filtered to its own source", async (path, source) => {
    expect(await resolveRedirect(path)).toBe(
      `${CONSOLE_ORIGIN}/platform/audit-log?source=${source}`,
    );
  });

  it("keeps the source filter when the old page carried query params of its own", async () => {
    // Verified against Next's own redirect path rather than assumed, and the
    // answer is not the one the plan expected. The request's params ARE carried
    // across a destination that has a query string of its own — they are merged
    // ahead of it, since the destination's values take priority and land last.
    //
    // The old pages' params are meaningless to the console (it offers no
    // severity, target or offset filter) but harmless, and the assertion is on
    // the whole string so the `source=` that IS load-bearing cannot be lost in
    // the merge without this failing.
    expect(
      await resolveRedirect("/admin/apps/mark8ly/audit-logs?severity=critical"),
    ).toBe(`${CONSOLE_ORIGIN}/platform/audit-log?severity=critical&source=mark8ly`);
    expect(
      await resolveRedirect("/admin/apps/kora/audit?target_id=f-1&offset=50"),
    ).toBe(
      `${CONSOLE_ORIGIN}/platform/audit-log?target_id=f-1&offset=50&source=kora`,
    );
  });

  it("does not let an inbound ?source override the product it came from", async () => {
    // A hand-edited `/admin/apps/kora/audit?source=mark8ly` must not land on
    // mark8ly's trail. The destination's own value wins outright — one `source`
    // key, not two — because it is spread last over the request's query.
    expect(await resolveRedirect("/admin/apps/kora/audit?source=mark8ly")).toBe(
      `${CONSOLE_ORIGIN}/platform/audit-log?source=kora`,
    );
  });

  it("leaves the rest of each product's admin alone", async () => {
    // The audit page is one entry in each product's rail. A `source` written
    // loosely — `/admin/apps/kora` — would retire the whole product section.
    expect(await resolveRedirect("/admin/apps/kora")).toBeNull();
    expect(await resolveRedirect("/admin/apps/kora/foods")).toBeNull();
    expect(await resolveRedirect("/admin/apps/mark8ly/tenants")).toBeNull();
    expect(await resolveRedirect("/admin/apps/homechef/orders")).toBeNull();
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
