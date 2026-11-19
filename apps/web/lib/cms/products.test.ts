import { describe, expect, it } from "vitest";
import { ICONS } from "@/components/marketing/icon";
import { fallbackProducts as products } from "./fallback/products";
import {
  countWord,
  industryListPlain,
  launchedProductSlugs,
} from "./products";

describe("product lineup", () => {
  it("launches Helivanta and Roamie, so the waitlist announcer treats both as live", () => {
    expect(launchedProductSlugs(products)).toEqual(
      expect.arrayContaining(["helivanta", "roamie"]),
    );
  });

  it("no longer lists the MediCare placeholder Helivanta replaced", () => {
    expect(Object.keys(products)).not.toContain("medicare");
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
    expect(industryListPlain(products)).toBe(
      "Commerce, food, healthcare, travel, rentals, nutrition",
    );
  });

  it("uses only icon names ProductIcon knows", () => {
    const names = Object.values(products).flatMap((p) => [p.icon, ...p.features.map((f) => f.icon)]);
    for (const n of names) expect(ICONS).toContain(n);
  });

  it("keeps portfolio order as the key order", () => {
    expect(Object.keys(products)).toEqual(["mark8ly", "fe3dr", "helivanta", "roamie", "dwellm8", "kora"]);
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
