import { describe, expect, it } from "vitest";

import {
  NO_REASON_CODES,
  hasReasonCodes,
  parseReasonCodes,
  reasonCodesFor,
  type ReasonCodeCatalog,
} from "./tenant-lifecycle";

/** A §8.8 body, as mark8ly actually serves it. */
const body = {
  data: {
    suspend: [
      { code: "abuse", label: "Abuse — abusive content or behaviour" },
      { code: "non_payment", label: "Non-payment — dunning exhausted" },
    ],
    unsuspend: [{ code: "appeal_upheld", label: "Appeal upheld" }],
    purge: [{ code: "erasure_request", label: "Erasure request" }],
  },
};

describe("parseReasonCodes", () => {
  it("reads the contract's shape, keeping the product's order", () => {
    const codes = parseReasonCodes(body);
    expect(codes.suspend?.map((c) => c.code)).toEqual(["abuse", "non_payment"]);
    expect(codes.suspend?.[0]?.label).toBe("Abuse — abusive content or behaviour");
  });

  // A product's set of consequential verbs is its own. Dropping what this
  // surface does not use would make the console the arbiter of what a product
  // is allowed to say, and would need changing again the day a purge form
  // exists.
  it("keeps verbs beyond the two this surface uses", () => {
    expect(parseReasonCodes(body).purge).toHaveLength(1);
  });

  // A menu option reading "undefined" is still selectable, and the write that
  // follows carries whatever code sat beside it.
  it("drops an entry with no usable code or label", () => {
    const codes = parseReasonCodes({
      data: {
        suspend: [
          { code: "abuse", label: "Abuse" },
          { code: "", label: "Blank" },
          { code: "no_label" },
          { code: "blank_label", label: "   " },
          "not an object",
        ],
      },
    });
    expect(codes.suspend?.map((c) => c.code)).toEqual(["abuse"]);
  });

  // Absent and empty are rendered differently by the caller — a gap versus an
  // empty menu — so a verb whose entries were all unusable must be absent.
  it("leaves a wholly unusable verb absent rather than empty", () => {
    const codes = parseReasonCodes({ data: { suspend: [{ code: "" }], unsuspend: [] } });
    expect("suspend" in codes).toBe(false);
    expect("unsuspend" in codes).toBe(false);
  });

  // "Published nothing" and "sent something malformed" are different facts and
  // only one of them is worth retrying.
  it("throws for a body that is not the contract's shape", () => {
    expect(() => parseReasonCodes(null)).toThrow();
    expect(() => parseReasonCodes([])).toThrow();
    expect(() => parseReasonCodes({})).toThrow();
    expect(() => parseReasonCodes({ data: [] })).toThrow();
  });
});

describe("reasonCodesFor", () => {
  const catalog: ReasonCodeCatalog = { mark8ly: parseReasonCodes(body) };

  it("offers the product's own codes", () => {
    expect(reasonCodesFor(catalog, "mark8ly", "suspend").map((c) => c.code)).toEqual([
      "abuse",
      "non_payment",
    ]);
  });

  // The reason a suspension ends is not the reason it began, and the product
  // says so by publishing two different sets.
  it("keeps the two verbs distinct", () => {
    const unsuspend = reasonCodesFor(catalog, "mark8ly", "unsuspend").map((c) => c.code);
    expect(unsuspend).toEqual(["appeal_upheld"]);
    expect(unsuspend).not.toContain("abuse");
  });

  // Borrowing one product's vocabulary for another's tenant is how a wrong
  // reason lands on an audit row. An empty menu is a visible gap; a borrowed
  // one is an invisible error.
  it("returns nothing for a product the catalog does not hold", () => {
    expect(reasonCodesFor(catalog, "kora", "suspend")).toEqual([]);
    expect(hasReasonCodes(catalog, "kora", "suspend")).toBe(false);
  });

  it("returns nothing at all for an empty catalog", () => {
    expect(reasonCodesFor(NO_REASON_CODES, "mark8ly", "suspend")).toEqual([]);
  });

  // Keyed on the verb, not the product: a product publishing suspend codes and
  // not unsuspend ones is a §8.8 deviation, and the console must render it as
  // a gap rather than open a dialog whose required field has no options.
  it("reports availability per verb, not per product", () => {
    const partial: ReasonCodeCatalog = {
      mark8ly: parseReasonCodes({ data: { suspend: [{ code: "abuse", label: "Abuse" }] } }),
    };
    expect(hasReasonCodes(partial, "mark8ly", "suspend")).toBe(true);
    expect(hasReasonCodes(partial, "mark8ly", "unsuspend")).toBe(false);
  });
});
