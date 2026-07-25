import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatINR,
  formatRelative,
  titleCase,
} from "./format";

describe("formatINR", () => {
  it("formats Indian-grouped rupees", () => {
    expect(formatINR(123456)).toBe("₹1,23,456");
  });
  it("falls back to 0 for null/undefined/NaN", () => {
    expect(formatINR(null)).toBe("₹0");
    expect(formatINR(undefined)).toBe("₹0");
    expect(formatINR(Number.NaN)).toBe("₹0");
  });
});

describe("formatCount", () => {
  it("groups with en-IN and zero-falls-back", () => {
    expect(formatCount(1234567)).toBe("12,34,567");
    expect(formatCount(null)).toBe("0");
  });
});

describe("formatDateTime / formatDate", () => {
  it("returns em dash for empty/invalid", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });
  it("formats a real date without throwing", () => {
    expect(formatDate("2026-01-15T10:00:00Z")).toContain("2026");
  });
});

describe("titleCase", () => {
  it("converts snake/kebab to Title Case", () => {
    expect(titleCase("payout_setup")).toBe("Payout Setup");
    expect(titleCase("delivery-failures")).toBe("Delivery Failures");
    expect(titleCase(null)).toBe("");
  });
});

describe("formatRelative", () => {
  it("says just now for very recent times", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 1000))).toBe("just now");
  });
  it("reports minutes and hours ago", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 60 * 1000))).toBe("5m ago");
    expect(formatRelative(new Date(Date.now() - 3 * 60 * 60 * 1000))).toBe("3h ago");
  });
  it("returns em dash for empty", () => {
    expect(formatRelative(null)).toBe("—");
  });
});
