import { expect, test, type Page } from "@playwright/test";

/**
 * Does each console surface render, and does a `"use server"` module load?
 *
 * Why this exists (#243). PR #239 fixed a production outage: `export type
 * { CrmActionResult };` in a `"use server"` module makes Next emit a type as
 * a runtime binding, so the compiled chunk throws `ReferenceError` the moment
 * it is evaluated. `tsc`, `next build`, `eslint` and `vitest` were all green,
 * because the defect exists only in the compiled server chunk at run time.
 * The e2e suite was green for a duller reason: it opened no detail page and
 * invoked no server action. The operator found it before any check did.
 *
 * Two guards here, and they are not the same guard:
 *
 * 1. `every console route renders` — one navigation per route. Catches a
 *    page, layout or component module that cannot render server-side at all.
 * 2. `a server action module evaluates` — one form submit. Catches the #239
 *    class specifically.
 *
 * WHY (2) IS NEEDED, AND (1) IS NOT ENOUGH. The issue assumed a broken
 * action module takes its page down on render, so merely visiting the route
 * would catch it. Under `next dev` — the only mode this suite can run in,
 * because middleware.ts refuses NEXT_PUBLIC_DEV_AUTH_BYPASS under
 * NODE_ENV=production — that is not true. Turbopack instantiates modules
 * lazily, and a `"use server"` module reached only through a client
 * component is a reference during SSR, not an import: a module-level `throw`
 * planted in all four console action modules fired for none of them while
 * their pages rendered 200. The module loads when an action is *called*. So
 * a render-only check cannot see this defect, and (2) submits a real form to
 * force the load. Verified: with the #239 export reintroduced, (2) fails
 * (500 on the action POST, `ReferenceError: CrmActionResult is not defined`
 * in the server log) while (1) stays green.
 *
 * WHY NO SEEDED DATA. Neither guard needs any. TESSERIX_DB_* is unset here
 * and apps/web is not running, so every surface below renders its error
 * state — which is a PASS, because a rendered error state proves the module
 * evaluated and the query ran. The failures being caught are total, not
 * cosmetic: nothing renders at all. That is what keeps this shallow, fast
 * and non-flaky.
 *
 * What this file does NOT cover, and why:
 *
 * - The content of any page. These assert that a page rendered, never that
 *   it rendered the right thing. Real data still needs a seeded database or
 *   a stub upstream — see the header of console.spec.ts.
 * - The three other action modules (`crm/[organisation]`, `crm/suppressions`,
 *   `crm/import`). Reaching their actions needs a record to act on, i.e.
 *   real data. `lib/server-action-type-export.guard.test.ts` (from #239) is
 *   what covers those: it reads the source of every `"use server"` module,
 *   so it is the broader guard of the two. This file's value is that it
 *   catches the failure *behaviourally*, including forms the source guard's
 *   pattern would not recognise.
 * - Route parameters that exist. The two detail routes below are visited
 *   with a well-formed UUID chosen to match nothing, so nothing here depends
 *   on production data.
 * - Authorization, as everywhere in this suite: the dev auth bypass is on,
 *   so the capability gates on these routes never run.
 */

// Well-formed v4 UUID, all-zero body — valid enough to clear the shape check
// in the CRM detail route (which 404s a malformed segment before querying),
// and vanishingly unlikely to identify a real record.
const ABSENT_UUID = "00000000-0000-4000-8000-000000000000";

const ROUTES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "console home", path: "/" },
  { name: "CRM home", path: "/platform/crm" },
  { name: "organisations browse", path: "/platform/crm/organisations" },
  { name: "new organisation", path: "/platform/crm/organisations/new" },
  { name: "CRM suppressions", path: "/platform/crm/suppressions" },
  { name: "CRM import", path: "/platform/crm/import" },
  { name: "audit log", path: "/platform/audit-log" },
  { name: "tickets queue", path: "/platform/tickets" },
  // The two detail routes — the coverage gap #243 was filed for.
  { name: "organisation detail", path: `/platform/crm/${ABSENT_UUID}` },
  { name: "ticket detail", path: `/platform/tickets/${ABSENT_UUID}` },
];

// The header's bell and palette poll these, and both 403 under the dev auth
// bypass. Stubbed for the same reason as in console.spec.ts: to keep failed
// background requests out of a test whose subject is the page render.
async function stubClientEndpoints(page: Page): Promise<void> {
  await page.route("**/api/notifications*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], unread: 0, lastSeenAt: null }),
    }),
  );
  await page.route("**/api/search*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }),
  );
}

/**
 * The console shell rendered: the `<main>` from app/(console)/layout and the
 * sidebar's navigation landmark. Next's default error boundary replaces that
 * layout with its own bare document, so this is what separates "the page
 * rendered its error state" from "the page could not render".
 */
async function expectConsoleChrome(page: Page): Promise<void> {
  await expect(page.locator("main#main-content")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: /navigation$/i }),
  ).toBeVisible();
}

test.describe("every console route renders server-side", () => {
  for (const { name, path } of ROUTES) {
    test(`${name} (${path}) renders without a server error`, async ({
      page,
    }) => {
      await stubClientEndpoints(page);

      const response = await page.goto(path);
      if (!response) throw new Error(`no response for ${path}`);

      // A module that fails to render is a 500. A not-found id (404) or a
      // failed query rendered as an error state (200) are both fine.
      expect(response.status()).toBeLessThan(500);
      await expectConsoleChrome(page);
    });
  }
});

test.describe("audit log renders on either transport", () => {
  // The estate audit log is the one surface with two upstream paths
  // (`lib/platform-api.ts#fetchEstateAuditLog`): apps/web's
  // `/api/admin/apps/:product/audit-logs` when `PLATFORM_API_ORIGIN` is
  // unset, and the platform API's `/v1/audit` when it is set. Both are
  // served by admin-stub.mjs so this test proves the same page renders
  // either way, without asserting on the fixture rows themselves — those
  // belong to the stub's own equivalence test (admin-stub.test.ts), not to
  // an e2e run whose subject is "did the page render", not "did it render
  // the right numbers".
  test("the audit log renders", async ({ page }) => {
    await stubClientEndpoints(page);

    const response = await page.goto("/platform/audit-log");
    if (!response) throw new Error("no response for /platform/audit-log");
    expect(response.status()).toBeLessThan(500);

    await expectConsoleChrome(page);
    // `level: 1` disambiguates deliberately. The page renders TWO headings
    // whose accessible names match /audit/i: the ConsolePageHeader -> h1
    // ("Audit log"), and an h3 that @tesserix/web's AuditLogViewer renders
    // for itself inside the timeline below (audit-timeline.tsx; its
    // AuditLogTitle part defaults to headingLevel 3). The h1 is the page's
    // own title and the only one, so level 1 is the stable target.
    await expect(
      page.getByRole("heading", { name: /audit/i, level: 1 }),
    ).toBeVisible();

    // Next's default error boundary renders this string when a server
    // component throws during render. Its absence is what tells "the page
    // rendered its (possibly degraded) state" apart from "the module
    // crashed" — the same distinction `expectConsoleChrome` draws via the
    // shell, made explicit here because this is the surface the cutover
    // touches.
    await expect(page.locator("body")).not.toContainText("Application error");
  });
});

test.describe("server action modules evaluate", () => {
  test("submitting the new-organisation form reaches its action", async ({
    page,
  }) => {
    // Would have caught #239. This is the console's only action reachable
    // without seeded data — the form is a client component that renders
    // unconditionally, and submitting it forces Next to load
    // crm/organisations/new/actions.ts on the server.
    //
    // The submitted URL is deliberately one the action refuses:
    // `isSafeWebsiteUrl` rejects a `javascript:` scheme (crm-url.ts), and
    // `createOrganisationAction` returns that refusal BEFORE entering
    // `withCrmWrite`. So this test writes nothing and audits nothing even
    // where the database IS reachable — it is a read-only probe of a write
    // path. `type="url"` on the field accepts the value, because
    // `javascript:alert(1)` is a well-formed absolute URL; only the app's
    // own scheme allowlist refuses it.
    await stubClientEndpoints(page);
    await page.goto("/platform/crm/organisations/new");

    await page.getByLabel("Organisation name").fill("E2E server-action probe");
    await page.getByLabel("Website").fill("javascript:alert(1)");

    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/platform/crm/organisations/new"),
    );
    await page.getByRole("button", { name: "Add organisation" }).click();

    // The load-bearing assertion: a module that throws at evaluation makes
    // this POST a 500.
    expect((await posted).status()).toBeLessThan(500);

    // And the action's own body ran, not just its module — the refusal is
    // rendered back into the form. Chosen over any success path because it
    // is the one outcome identical with and without a database.
    await expect(
      page.getByText("Website must be a web address starting with"),
    ).toBeVisible();
  });
});
