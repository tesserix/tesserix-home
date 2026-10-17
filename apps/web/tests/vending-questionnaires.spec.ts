import { test, expect, type Page } from "@playwright/test";
async function next(page: Page) {
  await page.getByRole("button", { name: "Continue →" }).click();
}
async function location(page: Page) {
  await page
    .getByRole("combobox", { name: "What type of location is this?" })
    .selectOption("gym");
  await page
    .getByRole("combobox", { name: "Country", exact: true })
    .selectOption("AU");
  await page
    .getByRole("textbox", { name: "City / suburb", exact: true })
    .fill("SYSTEM VERIFICATION");
  await page
    .getByRole("combobox", { name: "Currency for any prices you provide" })
    .selectOption("AUD");
}
test("customer submits product interest and can safely replay the receipt", async ({
  page,
  request,
}, testInfo) => {
  const analytics: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/analytics-config")) analytics.push(r.url());
  });
  await page.goto("/vending-customers?campaign=local-e2e");
  await location(page);
  await next(page);
  await page
    .getByRole("combobox", {
      name: "How often do you visit this type of location?",
    })
    .selectOption("weekly");
  await page
    .getByRole("combobox", { name: /If suitable products/ })
    .selectOption("weekly");
  await next(page);
  await page.getByRole("checkbox", { name: "Water", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Snack / protein bars", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Which would be your first choice?" })
    .selectOption("water");
  await next(page);
  await page
    .getByRole("spinbutton", {
      name: "Maximum you would pay for one snack / bar",
    })
    .fill("3.50");
  await page
    .getByRole("spinbutton", { name: "Maximum you would pay for one drink" })
    .fill("4.50");
  await page.getByRole("checkbox", { name: "Card", exact: true }).check();
  await page.getByRole("checkbox", { name: /I agree/ }).check();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/questionnaires/vending-customers") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Submit response" }).click(),
  ]);
  expect(response.status()).toBe(201);
  const saved = await response.json();
  await expect(
    page.getByRole("heading", {
      name: "Thank you for shaping what comes next.",
    }),
  ).toBeVisible();
  expect(analytics).toEqual([]);
  const sent = response.request();
  const replay = await request.post(sent.url(), {
    headers: { ...sent.headers(), origin: new URL(sent.url()).origin },
    data: sent.postDataJSON(),
  });
  expect(replay.status()).toBe(201);
  expect(await replay.json()).toEqual(saved);
  await page.screenshot({
    path: `/private/tmp/questionnaires-${testInfo.project.name}-customer.png`,
    fullPage: true,
  });
});
test("business submits a feasibility enquiry without accepting a contract", async ({
  page,
}, testInfo) => {
  await page.goto("/vending-business?campaign=local-e2e");
  await location(page);
  await page
    .getByRole("textbox", { name: "Business / organisation name" })
    .fill("SYSTEM VERIFICATION — synthetic venue");
  await page
    .getByRole("combobox", { name: /What is your role/ })
    .selectOption("decision-maker");
  await next(page);
  await page
    .getByRole("combobox", { name: /Estimated visits/ })
    .selectOption("200-499");
  await next(page);
  await page
    .getByRole("combobox", { name: /Is suitable continuous power/ })
    .selectOption("yes-dedicated-outlet");
  await page
    .getByRole("combobox", { name: "Available connectivity" })
    .selectOption("cellular-signal");
  await next(page);
  await page
    .getByRole("combobox", { name: "Preferred commercial arrangement" })
    .selectOption("negotiable");
  await next(page);
  await next(page);
  await page
    .getByRole("textbox", { name: "Contact name", exact: true })
    .fill("Synthetic Test");
  await page
    .getByRole("textbox", { name: "Business contact email" })
    .fill("verification@example.org");
  await page.getByRole("checkbox", { name: /I agree/ }).check();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/questionnaires/vending-business") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Submit response" }).click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(page.getByText(/This is not a rental agreement/)).toBeVisible();
  await page.screenshot({
    path: `/private/tmp/questionnaires-${testInfo.project.name}-business.png`,
    fullPage: true,
  });
});

for (const form of ["vending-customers", "vending-business"])
  test(`matches currencies, fills addresses and supports manual fallback for ${form}`, async ({
    page,
  }) => {
    await page.route("**/api/questionnaires/location", async (route) => {
      const body = route.request().postDataJSON();
      expect(route.request().headers()["cookie"]).toBeUndefined();
      await route.fulfill({
        json: {
          data: [
            {
              description: "Synthetic public venue",
              line1: "1 Example Street",
              city: "Example City",
              region: "Example Region",
              postal: "12345",
              country: body.country,
            },
          ],
        },
      });
    });
    await page.goto(`/${form}`);
    const country = page.getByRole("combobox", {
      name: "Country",
      exact: true,
    });
    const currency = page.getByRole("combobox", {
      name: "Currency for any prices you provide",
    });
    await country.selectOption("CA");
    await expect(currency).toHaveValue("CAD");
    const search = page.getByRole("combobox", {
      name: "Find the venue address (optional)",
    });
    await search.fill("Example venue");
    await expect(
      page.getByRole("option", { name: "Synthetic public venue", exact: true }),
    ).toBeVisible();
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(
      page.getByRole("textbox", {
        name: "Venue street address (optional)",
        exact: true,
      }),
    ).toHaveValue("1 Example Street");
    await expect(
      page.getByRole("textbox", { name: "City / suburb", exact: true }),
    ).toHaveValue("Example City");
    await expect(
      page.getByRole("textbox", {
        name: "State / region (optional)",
        exact: true,
      }),
    ).toHaveValue("Example Region");
    await expect(
      page.getByRole("textbox", { name: "Postcode / ZIP", exact: true }),
    ).toHaveValue("12345");
    await country.selectOption("JP");
    await expect(currency).toHaveValue("JPY");
    await expect(
      page.getByRole("textbox", { name: "City / suburb", exact: true }),
    ).toHaveValue("");
    await expect(search).toHaveValue("");
    await expect(
      page.getByRole("option", { name: "Synthetic public venue", exact: true }),
    ).toHaveCount(0);
    await page.route("**/api/questionnaires/location", (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "lookup_unavailable" } },
      }),
    );
    await search.fill("Another venue");
    await expect(page.getByRole("status")).toContainText(
      "enter all address details manually",
    );
    await page
      .getByRole("textbox", { name: "City / suburb", exact: true })
      .fill("Manual City");
    await expect(
      page.getByRole("textbox", { name: "City / suburb", exact: true }),
    ).toHaveValue("Manual City");
  });

test("Bhubaneswar presets stay editable and step changes focus the new section", async ({
  page,
}) => {
  await page.goto("/vending-customers?market=bhubaneswar");
  await expect(
    page.getByRole("combobox", { name: "Country", exact: true }),
  ).toHaveValue("IN");
  await expect(
    page.getByRole("textbox", {
      name: "State / region (optional)",
      exact: true,
    }),
  ).toHaveValue("Odisha");
  await expect(
    page.getByRole("textbox", { name: "City / suburb", exact: true }),
  ).toHaveValue("Bhubaneswar");
  await page
    .getByRole("combobox", { name: "What type of location is this?" })
    .selectOption("gym");
  await next(page);
  await expect(
    page.getByRole("heading", { name: "Habits", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("combobox", {
      name: "How often do you visit this type of location?",
    })
    .selectOption("weekly");
  await page
    .getByRole("combobox", { name: /If suitable products/ })
    .selectOption("weekly");
  await next(page);
  await page
    .getByRole("checkbox", { name: "Savoury Snacks", exact: true })
    .check();
  await page.getByText(/Savoury Snacks · .* ideas/).click();
  await page
    .getByRole("checkbox", {
      name: "Mudhi / puffed-rice snack mix",
      exact: true,
    })
    .check();
  await page
    .getByRole("combobox", { name: "Which would be your first choice?" })
    .selectOption("savoury-snacks");
  await next(page);
  await expect(
    page.getByRole("heading", { name: "Price and experience", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("alert").filter({ hasText: "Please acknowledge" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "UPI / QR", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
