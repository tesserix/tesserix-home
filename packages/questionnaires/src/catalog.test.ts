import { describe, expect, it } from "vitest";
import { VARIANTS, suggestedVariants, marketPreset } from "./catalog";
import { validateSubmission } from "./index";
const customer = {
  version: 1,
  country: "IN",
  region: "Gujarat",
  city: "Ahmedabad",
  currency: "INR",
  venueType: "gym",
  visitFrequency: "weekly",
  purchaseFrequency: "weekly",
  products: ["savoury-snacks", "coffee-tea", "fresh-juice", "yoghurt"],
  topProduct: "fresh-juice",
  paymentMethods: ["card"],
  consent: true,
  website: "",
};
describe("regional vending choices", () => {
  it("offers detailed juice, tea, coffee, protein shake and yoghurt choices", () => {
    for (const family of [
      "fresh-juice",
      "coffee-tea",
      "protein-shakes",
      "yoghurt",
    ])
      expect(
        VARIANTS.filter((v) => v.family === family).length,
      ).toBeGreaterThanOrEqual(5);
  });
  it("keeps IDs unique and serves regional suggestions from venue location", () => {
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(VARIANTS.length);
    const gujarat = suggestedVariants("IN", "Gujarat", ["savoury-snacks"]).map(
      (v) => v.id,
    );
    expect(gujarat).toContain("khakhra");
    expect(gujarat).not.toContain("vada-pav");
    expect(
      suggestedVariants("IN", "Maharashtra", ["savoury-snacks"]).map(
        (v) => v.id,
      ),
    ).toContain("vada-pav");
    expect(
      suggestedVariants("IN", "GJ", ["savoury-snacks"]).map((v) => v.id),
    ).toContain("khakhra");
  });
  it("has market examples for every supported country and exposes all cuisines as an option", () => {
    for (const country of [
      "AU",
      "NZ",
      "IN",
      "US",
      "CA",
      "GB",
      "FR",
      "DE",
      "IT",
      "NL",
      "ES",
      "BR",
      "JP",
      "SG",
      "MY",
      "ID",
      "TH",
      "PH",
      "AE",
      "SA",
    ])
      expect(VARIANTS.some((v) => v.countries?.includes(country))).toBe(true);
    expect(
      suggestedVariants("AU", "Victoria", ["savoury-snacks"], true).map(
        (v) => v.id,
      ),
    ).toContain("khakhra");
  });
  it("accepts valid details, rejects unknown or unrelated details and caps selection", () => {
    expect(
      validateSubmission("vending-customers", {
        ...customer,
        productVariants: [
          "khakhra",
          "masala-chai",
          "mango-juice",
          "greek-yoghurt",
        ],
      }).success,
    ).toBe(true);
    for (const productVariants of [
      ["unknown-stock-item"],
      ["whey-chocolate"],
      ["khakhra", "khakhra"],
      VARIANTS.slice(0, 13).map((v) => v.id),
    ])
      expect(
        validateSubmission("vending-customers", {
          ...customer,
          productVariants,
        }).success,
      ).toBe(false);
  });
  it("does not add optional detail defaults to old payloads, preserving receipt replay across releases", () => {
    const parsed = validateSubmission("vending-customers", customer);
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data).not.toHaveProperty("productVariants");
  });
  it("allows international choices regardless of suggested market", () => {
    expect(
      validateSubmission("vending-customers", {
        ...customer,
        country: "AU",
        currency: "AUD",
        productVariants: ["khakhra"],
      }).success,
    ).toBe(true);
  });
});

it("prefills Bhubaneswar and suggests Odisha choices without trapping respondents", () => {
  expect(marketPreset("bhubaneswar")).toEqual({
    country: "IN",
    region: "Odisha",
    city: "Bhubaneswar",
    currency: "INR",
    campaign: "bhubaneswar-pilot",
  });
  expect(marketPreset("https://evil.example")).toBeUndefined();
  const ids = suggestedVariants("IN", "OR", [
    "savoury-snacks",
    "confectionery",
    "fresh-juice",
  ]).map((v) => v.id);
  expect(ids).toEqual(
    expect.arrayContaining([
      "mudhi-mix",
      "chakuli-pitha",
      "chhena-poda",
      "khaja",
      "bel-pana",
    ]),
  );
  expect(
    suggestedVariants("PH", "Metro Manila", ["savoury-snacks"]).map(
      (v) => v.id,
    ),
  ).toContain("banana-chips");
});
it("records hospital approvals as research answers only and rejects them for another venue", () => {
  const business = {
    version: 1,
    country: "IN",
    region: "Odisha",
    city: "Bhubaneswar",
    currency: "INR",
    venueType: "hospital",
    businessName: "Synthetic hospital",
    authority: "researching",
    footfall: "unknown",
    power: "unknown",
    internet: "unknown",
    commercialModel: "not-interested",
    consent: true,
    website: "",
    requestedProducts: ["coffee-tea"],
    productVariants: ["masala-chai"],
    hospitalSaleArea: "public-lobby",
    hospitalApprovals: ["none"],
  };
  expect(validateSubmission("vending-business", business).success).toBe(true);
  expect(
    validateSubmission("vending-business", { ...business, venueType: "gym" })
      .success,
  ).toBe(false);
  expect(
    validateSubmission("vending-business", {
      ...business,
      hospitalApprovals: ["none", "facilities"],
    }).success,
  ).toBe(false);
  expect(
    validateSubmission("vending-business", {
      ...business,
      productVariants: ["khaja"],
    }).success,
  ).toBe(false);
});
