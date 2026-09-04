import { describe, expect, it } from "vitest";
import {
  CONTACT_SOURCE,
  LEGACY_LAWFUL_BASIS,
  SELECTABLE_LAWFUL_BASES,
  contactSourceLabel,
  isSelectableLawfulBasis,
  isStoredLawfulBasis,
  lawfulBasisLabel,
} from "./crm-provenance";

/**
 * The closed set behind `crm_contacts.lawful_basis` (#248).
 *
 * The distinction these tests exist to pin is the one the column cannot
 * express on its own: `not_recorded_pre_migration` is VALID TO HOLD — all 259
 * contacts in production carry it — and INVALID TO CHOOSE. A predicate that
 * conflated the two would either break the migrated rows or reopen the hole,
 * and both would still look like a validated enum.
 */
describe("lawful basis vocabulary", () => {
  it("admits the three bases an operator may choose", () => {
    expect(isSelectableLawfulBasis("legitimate_interests")).toBe(true);
    expect(isSelectableLawfulBasis("consent")).toBe(true);
    expect(isSelectableLawfulBasis("contract")).toBe(true);
  });

  it("refuses free text, so the column cannot drift back to what 0019 shipped", () => {
    expect(isSelectableLawfulBasis("because we felt like it")).toBe(false);
    expect(isSelectableLawfulBasis("")).toBe(false);
    expect(isSelectableLawfulBasis("LEGITIMATE_INTERESTS")).toBe(false);
    expect(isSelectableLawfulBasis(" consent")).toBe(false);
  });

  it("refuses non-strings rather than coercing them", () => {
    // These reach the predicate from a server action parameter, which is
    // network-reachable and typed only by convention.
    expect(isSelectableLawfulBasis(undefined)).toBe(false);
    expect(isSelectableLawfulBasis(null)).toBe(false);
    expect(isSelectableLawfulBasis(1)).toBe(false);
    expect(isSelectableLawfulBasis({ toString: () => "consent" })).toBe(false);
  });

  it("accepts the legacy marker for an EXISTING row but never offers it for a new one", () => {
    // Both halves in one test on purpose: they are one rule, and a suite that
    // asserted only the first would pass with the marker back in the picker.
    expect(isStoredLawfulBasis(LEGACY_LAWFUL_BASIS)).toBe(true);
    expect(isSelectableLawfulBasis(LEGACY_LAWFUL_BASIS)).toBe(false);
    expect(SELECTABLE_LAWFUL_BASES.map((basis) => basis.value)).not.toContain(
      LEGACY_LAWFUL_BASIS,
    );
  });

  it("gives every selectable basis a label and a description an operator can choose on", () => {
    for (const basis of SELECTABLE_LAWFUL_BASES) {
      expect(basis.label.length).toBeGreaterThan(0);
      expect(basis.description.length).toBeGreaterThan(0);
      expect(lawfulBasisLabel(basis.value)).toBe(basis.label);
    }
  });

  it("renders an absent basis as a finding, not as an empty string", () => {
    // The state #248 found for every contact created since the cutover. A
    // blank here would render as nothing at all on the detail page, which is
    // indistinguishable from the surface not being there.
    expect(lawfulBasisLabel(null)).toBe("Not recorded");
    expect(lawfulBasisLabel(LEGACY_LAWFUL_BASIS)).toMatch(/pre-migration/i);
  });

  it("shows an unrecognised stored value verbatim rather than hiding it", () => {
    expect(lawfulBasisLabel("some_future_basis")).toBe("some_future_basis");
  });
});

describe("contact source vocabulary", () => {
  it("names the write path, not the batch", () => {
    expect(CONTACT_SOURCE.import).toBe("import");
    expect(CONTACT_SOURCE.manual).toBe("manual");
  });

  it("labels the values live paths write, the pre-migration value, and anything else verbatim", () => {
    expect(contactSourceLabel("import")).toBe("CSV import");
    expect(contactSourceLabel("manual")).toBe("Added by hand");
    // The value on all 259 production rows.
    expect(contactSourceLabel("instagram_outreach")).toBe("Instagram outreach");
    expect(contactSourceLabel("something_else")).toBe("something_else");
    expect(contactSourceLabel(null)).toBe("Not recorded");
  });
});
