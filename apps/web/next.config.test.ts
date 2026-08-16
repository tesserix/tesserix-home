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
      appendParamsToQuery: true,
      destination: redirect.destination,
      params: match,
      query,
    });
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
