import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for the console's command palette and home route.
 *
 * Everything here depends on real layout, real CSS or the real bundle —
 * properties jsdom cannot see. If an assertion here would also pass under
 * jsdom it does not belong in this file; it belongs in the vitest suite.
 *
 * Under `NEXT_PUBLIC_DEV_AUTH_BYPASS=true` there is no session, so
 * `/api/search` and `/api/notifications` both 403. Both are stubbed below so
 * the bell and palette don't sit permanently in their unavailable state.
 */

const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control";

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

test.describe("console command palette", () => {
  test.beforeEach(async ({ page }) => {
    await stubClientEndpoints(page);
    await page.goto("/");
  });

  test("the palette renders as a centred fixed overlay, not a page element", async ({
    page,
  }) => {
    // Would have caught: the Tailwind `@source` path bug, where the dialog's
    // positioning classes generated no CSS and it rendered full-bleed in
    // document flow instead of as a centred overlay. Every assertion below
    // is impossible in jsdom (no layout engine, no computed styles), and
    // that missing-CSS regression would break every one of them.
    await page.getByRole("button", { name: /search/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const position = await dialog.evaluate(
      (el) => getComputedStyle(el).position,
    );
    expect(position).toBe("fixed");

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("viewport size unavailable");

    const box = await dialog.boundingBox();
    if (!box) throw new Error("dialog has no bounding box");

    // Horizontally centred within the viewport, to a few pixels.
    const dialogCenterX = box.x + box.width / 2;
    const viewportCenterX = viewport.width / 2;
    expect(Math.abs(dialogCenterX - viewportCenterX)).toBeLessThan(4);

    // Meaningfully narrower than the viewport — not full-bleed.
    expect(box.width).toBeLessThan(viewport.width * 0.9);

    // An overlay sits behind it: the dialog's element immediately preceding
    // sibling should be a fixed, full-viewport layer.
    const overlayCoversViewport = await dialog.evaluate((el, vp) => {
      const overlay = el.previousElementSibling;
      if (!overlay) return false;
      const style = getComputedStyle(overlay);
      const rect = overlay.getBoundingClientRect();
      return (
        style.position === "fixed" &&
        rect.width >= vp.width - 1 &&
        rect.height >= vp.height - 1
      );
    }, viewport);
    expect(overlayCoversViewport).toBe(true);
  });

  test("the search input's focus ring is not clipped by the dialog panel", async ({
    page,
  }) => {
    // Would have caught: the clipped input ring. The dialog panel clips with
    // `overflow-hidden` and the input sits flush against its top edge, so an
    // outward-drawn ring (the app's global default `outline-offset: 3px`)
    // got sliced off. This is a proxy for the property we actually want —
    // "nothing is painted outside the clip box" — which cannot be measured
    // directly in Playwright, so we instead assert the two conditions that
    // together guarantee it: the ring is drawn inward (non-positive
    // outline-offset) and the input's own box does not project above the
    // dialog's clip boundary.
    //
    // FINDING (see task-2-report.md): this fails. The input does carry
    // `focus-visible:outline-offset-[-2px]` and the utility compiles into
    // real CSS, but `app/globals.css` also declares a hand-written
    // `:focus-visible { outline-offset: 3px; }` outside any `@layer`. In the
    // CSS cascade, unlayered rules always beat rules inside a layer —
    // Tailwind's utilities are emitted inside `@layer utilities` — so the
    // global 3px rule wins regardless of the utility's higher selector
    // specificity. The clipped-ring fix does not take effect.
    await page.getByRole("button", { name: /search/i }).click();
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");
    await input.focus();

    const outlineOffset = await input.evaluate((el) =>
      parseFloat(getComputedStyle(el).outlineOffset || "0"),
    );
    expect(outlineOffset).toBeLessThanOrEqual(0);

    const dialogBox = await dialog.boundingBox();
    const inputBox = await input.boundingBox();
    if (!dialogBox || !inputBox) throw new Error("missing bounding box");

    // The input's top edge must sit at or below the dialog's top edge — an
    // outward ring on a flush-mounted input would otherwise paint above the
    // panel's own clip boundary.
    expect(inputBox.y).toBeGreaterThanOrEqual(dialogBox.y - 1);
  });

  test("keyboard navigation works end to end: open, narrow, arrow, enter, escape", async ({
    page,
  }) => {
    // The single most valuable test in this file. Would have caught:
    // design-system#7 — the primitive's key handler lives on CommandList
    // (the listbox), a DOM *sibling* of CommandInput, so a keydown fired
    // from the search box never reached it. The console carries a
    // `forwardToListbox` workaround (component.tsx) that no jsdom test can
    // validate, because jsdom does not dispatch real bubbling browser
    // keyboard events through this component tree the way Chromium does.

    // 1. Open from the console home via the real shortcut.
    await page.keyboard.press(`${MOD_KEY}+k`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("textbox");
    await expect(input).toBeFocused();

    // 2. Typing narrows the list. "cost" matches exactly two tools —
    // Kubecost and Cost estimator (packages/console-core/src/tools.ts) — so
    // the highlight transition below is actually observable. A query with a
    // single match is already active before any key press and proves
    // nothing.
    //
    // Note: as shipped, typing alone does not pre-highlight a row —
    // `CommandInput`'s onChange reads `getVisibleItems()` synchronously,
    // before the newly-filtered items have registered, so it captures a
    // value from the *previous* filter. Neither of these two rows carries
    // `data-active="true"` until a key is pressed. That staleness is a
    // separate, real finding — see the pending-route test below, which
    // exercises exactly the case where it bites (Enter fired before any
    // arrow key touches it). Here we press ArrowDown first specifically to
    // land on a known, correct row before asserting the transition.
    await input.fill("cost");
    const options = dialog.getByRole("option");
    await expect(options).toHaveCount(2);
    const firstOption = options.nth(0);
    const secondOption = options.nth(1);

    // 3. First ArrowDown lands on the first visible row (the stale pointer
    // from before filtering isn't found in the current list, so the
    // primitive falls back to index 0) — this is itself proof the arrow key
    // reaches the listbox at all, i.e. the design-system#7 forwarding
    // workaround is doing its job.
    await input.press("ArrowDown");
    await expect(firstOption).toHaveAttribute("data-active", "true");
    await expect(secondOption).toHaveAttribute("data-active", "false");

    // ArrowDown again visibly moves the highlight to the next row.
    await input.press("ArrowDown");
    await expect(firstOption).toHaveAttribute("data-active", "false");
    await expect(secondOption).toHaveAttribute("data-active", "true");

    // 4. Enter on the highlighted row navigates and the URL changes. Retype
    // a query that uniquely matches the one navigable route under test,
    // "Platform · Tickets" (platform.tickets), so Enter's destination is
    // unambiguous — then ArrowDown once to establish a known-correct active
    // row before pressing Enter, for the reason noted above.
    await input.fill("");
    await input.fill("tickets");
    const ticketsOption = dialog.getByRole("option", {
      name: /Platform · Tickets/i,
    });
    await expect(ticketsOption).toHaveCount(1);
    await input.press("ArrowDown");
    await expect(ticketsOption).toHaveAttribute("data-active", "true");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/platform\/tickets$/);
    await expect(dialog).not.toBeVisible();

    // 5. Escape closes the palette (reopen first, since Enter above already
    // closed it as part of navigation).
    await page.keyboard.press(`${MOD_KEY}+k`);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("⌘K does not hijack typing in an unrelated text input", async ({
    page,
  }) => {
    // Insurance, not a regression test — this would have caught nothing
    // that has shipped yet. Guards the "isTypingElsewhere" check in
    // command-palette.tsx: focus a plain text input elsewhere on the page,
    // press the shortcut, and the palette must not open — an operator
    // typing "k" into a form field must get a literal "k".
    await page.evaluate(() => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "e2e-scratch-input";
      document.body.appendChild(el);
    });
    const scratchInput = page.locator("#e2e-scratch-input");
    await scratchInput.focus();

    await page.keyboard.press(`${MOD_KEY}+k`);

    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("a pending route renders in the palette but Enter does not navigate", async ({
    page,
  }) => {
    // Would have caught: a regression in the disabled-route handling that
    // the unit suite only checks structurally (that `disabled` is set), not
    // behaviourally (that a real Enter keypress in a real browser is unable
    // to activate it).
    //
    // This test typed a query and pressed Enter immediately, with no arrow
    // key in between — the natural "type then Enter" flow for a single
    // result. That is exactly the case that surfaced a real defect (see the
    // finding at the bottom of this test), so this assertion is left as
    // written rather than adapted to dodge it.
    await page.keyboard.press(`${MOD_KEY}+k`);
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");

    // "break glass" matches exactly the pending platform.breakGlass route.
    await input.fill("break glass");
    const pendingOption = dialog.getByRole("option", {
      name: /Platform · Break Glass/i,
    });
    await expect(pendingOption).toHaveCount(1);
    await expect(pendingOption).toBeDisabled();

    const urlBefore = page.url();
    await input.press("Enter");
    await page.waitForTimeout(200);
    expect(page.url()).toBe(urlBefore);
    // FINDING (see task-2-report.md): this fails. Disabled rows never
    // register with the primitive's `activeValue`, so pressing Enter here
    // should be a no-op — but `CommandInput`'s onChange sets `activeValue`
    // synchronously from the *previous* filter's visible items, before the
    // new ("break glass"-only, all-disabled) list has registered. That
    // stale pointer is a real, off-screen, non-disabled entry from before
    // typing (in this run, `platform.dashboard`), and it is still truthy —
    // so `CommandList`'s Enter handler fires `onValueChange` on it anyway.
    // The dialog closes and `router.push` runs against a phantom selection
    // the user never saw highlighted. It only *looks* like nothing happened
    // here because that particular phantom route happens to resolve to the
    // current URL ("/"); against any other prior selection this would be a
    // silent, invisible navigation.
    await expect(dialog).toBeVisible();
  });
});

test.describe("console home route", () => {
  test.beforeEach(async ({ page }) => {
    await stubClientEndpoints(page);
  });

  test("the console home is reachable and the sidebar links to it", async ({
    page,
  }) => {
    // Would have caught: platform.dashboard being marked `pending`, which
    // left the console with no link back home at all — every "Dashboard"
    // entry rendered as an inert, unlinked "soon" row.
    await page.goto("/");

    // Exact match: the internal-tools directory on this page also links out
    // to "Grafana Dashboards and charts", which a loose /dashboard/i match
    // would ambiguously catch too.
    const dashboardLink = page.getByRole("link", { name: "Dashboard", exact: true });
    await expect(dashboardLink).toBeVisible();
    await expect(dashboardLink).toHaveAttribute("href", "/");
    await expect(dashboardLink).not.toContainText(/soon/i);

    // Navigate away and back through it.
    await page.goto("/platform/tickets");
    await expect(page).toHaveURL(/\/platform\/tickets$/);

    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});
