import { describe, expect, it } from "vitest";
import { countryFromLocation, COUNTRY_LABELS } from "./crm-country";

describe("countryFromLocation", () => {
  it("maps a bare country name", () => {
    expect(countryFromLocation("Australia")).toBe("AU");
  });

  it("maps Indian cities and states to IN", () => {
    // The scrape returns city, state and "city, state" interchangeably —
    // Chennai, Kerala and "Mumbai, Maharashtra" are all one country.
    expect(countryFromLocation("Chennai")).toBe("IN");
    expect(countryFromLocation("Kerala")).toBe("IN");
    expect(countryFromLocation("Mumbai, Maharashtra")).toBe("IN");
    expect(countryFromLocation("Delhi")).toBe("IN");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(countryFromLocation("  chennai ")).toBe("IN");
  });

  it("returns null for an unknown location rather than guessing", () => {
    // A wrong country is worse than no country: it silently files a lead
    // under a market it is not in, and the operator has no way to notice.
    expect(countryFromLocation("Somewhere Else")).toBeNull();
    expect(countryFromLocation(null)).toBeNull();
    expect(countryFromLocation("")).toBeNull();
  });

  it("resolves the segment after the last comma even when the whole string doesn't match", () => {
    // "City, State" style values: the whole string won't be in the table,
    // but the state after the comma will be.
    expect(countryFromLocation("Kochi, Kerala")).toBe("IN");
  });

  it("COUNTRY_LABELS carries a display name for every code the mapper can return", () => {
    expect(COUNTRY_LABELS.AU).toBe("Australia");
    expect(COUNTRY_LABELS.IN).toBe("India");
  });
});
