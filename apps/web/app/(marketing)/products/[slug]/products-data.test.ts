import { describe, expect, it } from "vitest";
import {
  countWord,
  industryListPlain,
  launchedProductSlugs,
  products,
  productSlugs,
} from "./products-data";

describe("product lineup", () => {
  it("launches Helivanta and Roamie, so the waitlist announcer treats both as live", () => {
    expect(launchedProductSlugs()).toEqual(
      expect.arrayContaining(["helivanta", "roamie"]),
    );
  });

  it("no longer lists the MediCare placeholder Helivanta replaced", () => {
    expect(productSlugs).not.toContain("medicare");
  });

  it("links Roamie to Google Play and keeps its App Store listing pending review", () => {
    expect(products.roamie.listings).toEqual({
      android: {
        url: "https://play.google.com/store/apps/details?id=app.tesserix.roamie",
        artworkSrc: "/badges/google-play-badge.png",
      },
      ios: { url: "", artworkSrc: "/badges/app-store-badge.svg" },
    });
  });

  it("sends Helivanta visitors to helivanta.app, not the unrelated helivanta.com", () => {
    expect(products.helivanta.website).toBe("https://helivanta.app");
  });

  it("adds travel to the industries the hero and footer quote", () => {
    expect(industryListPlain()).toBe(
      "Commerce, food, healthcare, travel, rentals, nutrition",
    );
  });
});

describe("countWord", () => {
  it("spells small counts for marketing copy", () => {
    expect(countWord(1)).toBe("one");
    expect(countWord(6)).toBe("six");
    expect(countWord(10)).toBe("ten");
  });

  it("falls back to digits past ten rather than inventing a word", () => {
    expect(countWord(11)).toBe("11");
  });
});
