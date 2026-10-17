import { test, expect, type Page } from "@playwright/test";
async function next(page: Page) {
  await page.getByRole("button", { name: "Continue →" }).click();
}
async function location(page: Page) {
  await page
    .getByRole("combobox", { name: "What type of location is this?" })
    .selectOption("gym");
  await page
    .getByRole("textbox", { name: "Country code", exact: true })
    .fill("AU");
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
    .getByRole("checkbox", { name: "Protein Bars", exact: true })
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
