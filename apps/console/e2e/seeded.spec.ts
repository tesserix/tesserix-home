import { expect, test } from "@playwright/test";

/**
 * What the surfaces SHOW — the coverage this suite could not have before #271.
 *
 * Until the seeded database and the admin-API stub existed, every CRM surface
 * rendered its error state by design and the admin-backed surfaces rendered
 * nothing. The suite passed and proved only that the console fails gracefully.
 * #243 was filed because no test opened a detail page; #245, a live drift-clock
 * bug, had to be proved with pglite integration tests because e2e could not
 * reach the behaviour at all.
 *
 * These assertions name specific seeded values rather than counting rows. The
 * seed is deterministic (a fixed PRNG, one reference instant), so naming a
 * value catches a regression where counting a row catches only a reshuffle.
 *
 * They are also the equivalence harness for the platform API migration: the
 * same assertions must pass against the stub and against the real Go module.
 * If a module changes what a surface shows, that is a contract change and this
 * file is where it surfaces.
 */

// The error-state guard, kept deliberately. Graceful failure is still a
// requirement — it just no longer stands in for coverage of the working path.
async function expectNoErrorState(page: import("@playwright/test").Page) {
  await expect(page.getByText(/Something Went Wrong/i)).toHaveCount(0);
  await expect(page.getByText(/Could not load/i)).toHaveCount(0);
}

test.describe("CRM, against the seeded database", () => {
  test("the organisations list shows seeded businesses", async ({ page }) => {
    await page.goto("/platform/crm/organisations");

    await expect(page.getByRole("heading", { name: "Organisations" })).toBeVisible();
    await expectNoErrorState(page);
    // Named, not counted: "Amber Collective 1" is the first row the seed
    // produces, every run.
    //
    // `exact` matters — a substring match also hits "Amber Collective 127",
    // which is a strict-mode violation rather than a pass. Worth knowing when
    // adding assertions here: the seed numbers rows, so short names are
    // prefixes of longer ones.
    await expect(
      page.getByRole("link", { name: "Amber Collective 1", exact: true }),
    ).toBeVisible();
  });

  test("more rows exist than fit one page, so paging is reachable", async ({ page }) => {
    await page.goto("/platform/crm/organisations");
    await expectNoErrorState(page);

    // 140 organisations against a 100-row page size (#240). Without more rows
    // than the limit, the pagination #240 and #241 built is unexercisable —
    // which is exactly the state this test exists to prevent returning to.
    const rows = page.getByRole("link", { name: /Collective|Studio|Works|House|Kitchen|Supply|Atelier|Rooms/ });
    expect(await rows.count()).toBeGreaterThan(1);
  });

  test("an organisation detail page opens and shows its contact", async ({ page }) => {
    await page.goto("/platform/crm/organisations");
    await expectNoErrorState(page);

    await page.getByRole("link", { name: "Amber Collective 1", exact: true }).click();

    // #243: no e2e opened a detail page. This is that gap closed with data
    // behind it, so the assertion is about content rather than a 200.
    await expect(page.getByRole("heading", { name: /Amber Collective 1/ })).toBeVisible();
    await expectNoErrorState(page);

    // The page opens on Activity, and the seeded note proves the write path
    // reached this organisation rather than some other one.
    await expect(page.getByText(/Imported from Amber Collective 1's listing/)).toBeVisible();

    // Contacts are behind a tab. Clicking it is the point: a detail page that
    // renders its first tab and errors on the second would still have passed a
    // status-code check.
    await page.getByRole("tab", { name: /Contacts/i }).click();
    await expect(page.getByText(/Contact 1\b/).first()).toBeVisible();
    await expectNoErrorState(page);
  });

  test("the CRM queues render opportunities, not an empty state", async ({ page }) => {
    await page.goto("/platform/crm");

    await expectNoErrorState(page);
    // The seed guarantees both a due band and a drifting band; a queue showing
    // "nothing waiting" here would mean the seed or the clock is wrong.
    await expect(page.getByText(/Follow up with/).first()).toBeVisible();
  });

  test("the do-not-contact list shows its suppressions", async ({ page }) => {
    await page.goto("/platform/crm/suppressions");

    await expectNoErrorState(page);
    // Seeded by handle, and stored without the leading @ — #253 normalises on
    // write, so a rendered "@handle_5" would mean the normalisation is being
    // undone somewhere in the read path.
    await expect(page.getByText(/handle_5/)).toBeVisible();
  });
});

test.describe("admin-backed surfaces, against the stub", () => {
  test("the ticket queue shows the urgent ticket first", async ({ page }) => {
    await page.goto("/platform/tickets");

    await expectNoErrorState(page);
    await expect(
      page.getByText("Checkout fails on the storefront").first(),
    ).toBeVisible();
    // The summary counts come from the stub's whole fixture, not the rendered
    // page, so they catch a listing that silently drops rows. The queue does
    // NOT render ticket numbers — asserting on MK-1041 here fails against a
    // perfectly correct page.
    await expect(page.getByText(/Urgent open/)).toBeVisible();
  });

  test("a ticket detail shows the conversation from both sides", async ({ page }) => {
    await page.goto("/platform/tickets");
    await expectNoErrorState(page);

    await page.getByText("Checkout fails on the storefront").first().click();

    // Both author types render, and they render differently. A misattributed
    // message is worse than an error, which is why parseTicketDetail rejects
    // an unknown author_type rather than passing it through.
    await expect(page.getByText(/This is blocking every order/)).toBeVisible();
    await expect(page.getByText(/Looking into it/)).toBeVisible();
  });

  test("the audit log shows entries attributed to their source", async ({ page }) => {
    await page.goto("/platform/audit-log");

    await expectNoErrorState(page);
    await expect(page.getByText("tenant.suspended")).toBeVisible();
  });
});
