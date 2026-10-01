import { describe, expect, it } from "vitest";
import {
  countryFromLocation,
  COUNTRY_LABELS,
  COUNTRY_BY_LOCATION,
  planBackfill,
} from "./crm-country";

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

  // The nine markets the 2026-09 sweep imported. These are the EXACT values
  // the live unmapped report returned for 165 organisations — not invented
  // examples — so a regression here is a regression against real rows.
  it.each([
    ["Canada", "CA"],
    ["Italy", "IT"],
    ["Germany", "DE"],
    ["USA", "US"],
    ["UK", "GB"],
    ["France", "FR"],
    ["Netherlands", "NL"],
    ["New Zealand", "NZ"],
    ["Spain", "ES"],
  ])("maps the swept market %s to %s", (location, code) => {
    expect(countryFromLocation(location)).toBe(code);
  });

  // GB and not UK: the column stores ISO 3166-1 alpha-2, where the United
  // Kingdom is GB. "UK" is what a person types, never what is stored.
  it("stores the UK as its ISO code, not the colloquial one", () => {
    expect(countryFromLocation("UK")).toBe("GB");
    expect(countryFromLocation("United Kingdom")).toBe("GB");
    expect(countryFromLocation("Scotland")).toBe("GB");
  });

  it.each([
    ["Deutschland", "DE"],
    ["Italia", "IT"],
    ["Nederland", "NL"],
    ["España", "ES"],
    ["Aotearoa", "NZ"],
    ["United States of America", "US"],
  ])("maps %s, the form a seller writes it in, to %s", (location, code) => {
    expect(countryFromLocation(location)).toBe(code);
  });

  // The markets deliberately NOT added: Belgium contaminated the Dutch and
  // French sweeps and is not a supported market, so it must stay null rather
  // than being filed under NL for looking Dutch.
  it.each(["Belgium", "Austria", "Switzerland", "Brazil"])(
    "leaves the unsupported market %s unmapped",
    (location) => {
      expect(countryFromLocation(location)).toBeNull();
    },
  );

  it("maps production locations found unmapped in a live run", () => {
    // Fix round 1: these 10 distinct locations (Indian, every one) were
    // seen in production and returned null before this table was extended.
    // "Ranchi, Jharkhand" is covered by adding the missing "jharkhand"
    // state entry (the "City, State" parse already worked — see
    // "Kochi, Kerala" above — Jharkhand was simply absent from the state
    // table), not a hardcoded "ranchi" entry.
    expect(countryFromLocation("Aluva")).toBe("IN");
    expect(countryFromLocation("Borivali East")).toBe("IN");
    expect(countryFromLocation("Navi Mumbai")).toBe("IN");
    expect(countryFromLocation("Puthanathani")).toBe("IN");
    expect(countryFromLocation("Ranchi, Jharkhand")).toBe("IN");
    expect(countryFromLocation("Salua")).toBe("IN");
    expect(countryFromLocation("Sindhudurg")).toBe("IN");
    expect(countryFromLocation("Siliguri")).toBe("IN");
    expect(countryFromLocation("Srinagar")).toBe("IN");
    expect(countryFromLocation("Mathura Vrindavan")).toBe("IN");
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

  it("does not substring-match a recognised name inside an unrecognised comma segment", () => {
    // Guards the exact-match contract: "Ohio" isn't in the table, and
    // "delhi" merely appearing inside "Delhi Road" must not count as a
    // match. If a future edit swapped the lookup for `.includes()`, this
    // is the test that would catch it — matching wrongly here is the exact
    // failure mode this module exists to avoid (a lead filed under a
    // market it isn't in, with nothing to flag it).
    expect(countryFromLocation("Delhi Road, Ohio")).toBeNull();
    expect(countryFromLocation("Delhi Road")).toBeNull();
  });

  it("returns null for Object.prototype member names, not the inherited member", () => {
    // `location` comes from a CSV cell or the manual-create form, and the
    // result is bound straight into `country`. An unguarded index into the
    // lookup object read through the prototype chain, so "constructor"
    // returned the `Object` function and "__proto__" returned an object —
    // both non-strings, in a column typed text, from untrusted input.
    for (const key of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(countryFromLocation(key)).toBeNull();
      // The comma branch does its own lookup and needs its own guard.
      expect(countryFromLocation(`Somewhere, ${key}`)).toBeNull();
    }
  });

  it("COUNTRY_LABELS has a display name for every code the lookup table can produce", () => {
    // Derived from the table's own value set rather than a hand-written
    // list of codes, so a new code added to COUNTRY_BY_LOCATION without a
    // matching label fails this test instead of silently reaching the UI
    // as a bare, unlabeled code.
    const codesInTable = new Set(Object.values(COUNTRY_BY_LOCATION));
    expect(codesInTable.size).toBeGreaterThan(0);
    for (const code of codesInTable) {
      expect(COUNTRY_LABELS[code]).toBeTruthy();
    }
  });
});

describe("planBackfill", () => {
  it("splits rows into mapped and unmapped, leaving NULL locations out of both", () => {
    const rows = [
      { id: 1, location: "Australia" },
      { id: 2, location: "Chennai" },
      { id: 3, location: null },
      { id: 4, location: "Mumbai, Maharashtra" },
      { id: 5, location: "Narnia" },
    ];

    const result = planBackfill(rows);

    expect(result.mapped).toEqual([
      { id: 1, country: "AU" },
      { id: 2, country: "IN" },
      { id: 4, country: "IN" },
    ]);
    expect(result.unmappedRowCount).toBe(1);
    expect(result.unmappedLocations).toEqual(["Narnia"]);
  });

  it("counts every unmapped ROW, not just distinct unmapped locations", () => {
    // Two organisations sharing one unrecognised location must not collapse
    // into one in the row count — that's exactly the arithmetic bug this
    // test guards: `unmappedRowCount` has to sum with `mapped.length` to
    // `rows.length`, which only holds if it counts rows, not distinct
    // strings.
    const rows = [
      { id: 1, location: "Narnia" },
      { id: 2, location: "Narnia" },
      { id: 3, location: "Chennai" },
    ];

    const result = planBackfill(rows);

    expect(result.unmappedRowCount).toBe(2);
    expect(result.unmappedLocations).toEqual(["Narnia"]);

    // Explicit total check: mapped rows + unmapped rows + no-location rows
    // must equal every row read. With no null-location rows here, that
    // means mapped + unmapped alone accounts for all 3.
    expect(result.mapped.length + result.unmappedRowCount).toBe(rows.length);
  });

  it("never counts a NULL location as unmapped", () => {
    const rows = [
      { id: 1, location: null },
      { id: 2, location: null },
    ];

    const result = planBackfill(rows);

    expect(result.mapped).toEqual([]);
    expect(result.unmappedRowCount).toBe(0);
    expect(result.unmappedLocations).toEqual([]);
  });
});
