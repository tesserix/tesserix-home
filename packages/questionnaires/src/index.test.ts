import { describe, expect, it } from "vitest";
import { validateSubmission } from "./index";
describe("customer questionnaire", () => {
  it("accepts a negative demand response without inventing a product preference", () => {
    const result = validateSubmission("vending-customers", {
      version: 1,
      venueType: "gym",
      country: "AU",
      city: "Melbourne",
      currency: "AUD",
      visitFrequency: "weekly",
      purchaseFrequency: "never",
      products: [],
      topProduct: "none",
      maxSnackPrice: 0,
      maxDrinkPrice: 0,
      paymentMethods: ["card"],
      dietaryPreferences: ["none"],
      purchaseBarriers: ["not-needed"],
      consent: true,
      website: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("survey boundaries", () => {
  const valid = {
    version: 1,
    venueType: "gym",
    country: "AU",
    city: "Melbourne",
    currency: "AUD",
    visitFrequency: "weekly",
    purchaseFrequency: "never",
    products: [],
    topProduct: "none",
    paymentMethods: ["card"],
    consent: true,
    website: "",
  };
  it.each([
    { consent: false },
    { version: 2 },
    { website: "https://spam.example" },
    { tenantId: "other-tenant" },
    { products: ["water"], topProduct: "none" },
    { products: ["water", "water"], topProduct: "water" },
    { products: ["water"], topProduct: "chocolate" },
    { maxSnackPrice: -1 },
    { maxSnackPrice: 1.234 },
    { paymentMethods: [] },
  ])("rejects invalid or contradictory input %j", (patch) => {
    expect(
      validateSubmission("vending-customers", { ...valid, ...patch }).success,
    ).toBe(false);
  });
  it("accepts unicode venue names and declines to require personal customer details", () => {
    const r = validateSubmission("vending-customers", {
      ...valid,
      city: "東京",
      venueName: "ジム",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty("contactEmail");
  });
  it("keeps business and customer forms isolated", () => {
    expect(validateSubmission("vending-business", valid).success).toBe(false);
    expect(
      validateSubmission("vending-customers", {
        ...valid,
        contactEmail: "owner@example.org",
      }).success,
    ).toBe(false);
  });
});

it("accepts a business declining a pilot without collecting a person’s contact information", () => {
  expect(
    validateSubmission("vending-business", {
      version: 1,
      venueType: "gym",
      country: "AU",
      city: "Melbourne",
      currency: "AUD",
      businessName: "Example gym",
      authority: "site-manager",
      footfall: "unknown",
      power: "unknown",
      internet: "unknown",
      commercialModel: "not-interested",
      consent: true,
      website: "",
    }).success,
  ).toBe(true);
});
