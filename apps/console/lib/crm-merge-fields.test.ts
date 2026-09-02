import { describe, expect, it } from "vitest";
import {
  MERGE_FIELDS,
  UnknownMergeFieldError,
  parseMergeFields,
  renderTemplate,
} from "./crm-merge-fields";

/**
 * The assertion that matters most in this file is the NEGATIVE one:
 * `expect("text" in result).toBe(false)`. A renderer that returned text
 * alongside a warning would pass every "names the missing field" test here
 * while still shipping "Hi ," to a lead, because a caller can ignore a
 * warning and cannot ignore an absent property. Every failure case therefore
 * asserts the absence of `text`, not just the presence of the diagnosis.
 */

const FULL = {
  "org.name": "Bondi Sourdough",
  "org.location": "Bondi Beach, NSW",
  "org.category": ["Bakery", "Cafe"],
  "contact.name": "Alex",
  "contact.instagram_handle": "bondisourdough",
  "contact.biography": "artisan sourdough since 2019",
};

describe("MERGE_FIELDS", () => {
  it("contains exactly the six column-backed fields and nothing derived", () => {
    expect(Object.keys(MERGE_FIELDS).sort()).toEqual([
      "contact.biography",
      "contact.instagram_handle",
      "contact.name",
      "org.category",
      "org.location",
      "org.name",
    ]);
  });

  it("names a real column behind every field", () => {
    for (const field of Object.values(MERGE_FIELDS)) {
      expect(field.source).toMatch(/^crm_(organisations|contacts)\.[a-z_]+$/);
      expect(field.label.length).toBeGreaterThan(0);
    }
  });

  it("is frozen, so no caller can register a field without a column behind it", () => {
    expect(Object.isFrozen(MERGE_FIELDS)).toBe(true);
  });
});

describe("parseMergeFields", () => {
  it("returns the referenced fields in template order", () => {
    expect(parseMergeFields("Hi {{contact.name}} at {{org.name}}")).toEqual([
      "contact.name",
      "org.name",
    ]);
  });

  it("dedupes a field referenced twice", () => {
    expect(parseMergeFields("{{org.name}} — love {{org.name}}")).toEqual(["org.name"]);
  });

  it("returns nothing for a body with no placeholders", () => {
    expect(parseMergeFields("Hi there")).toEqual([]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(parseMergeFields("Hi {{ contact.name }}")).toEqual(["contact.name"]);
  });

  it("throws on an unknown token rather than silently keeping it", () => {
    expect(() => parseMergeFields("Hi {{contact.followers}}")).toThrow(UnknownMergeFieldError);
  });

  it("names every unknown token, so one authoring pass fixes them all", () => {
    try {
      parseMergeFields("{{contact.followers}} and {{org.abn}}");
      expect.unreachable("expected UnknownMergeFieldError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(UnknownMergeFieldError);
      expect((cause as UnknownMergeFieldError).unknown).toEqual(["contact.followers", "org.abn"]);
      expect((cause as UnknownMergeFieldError).message).toContain("contact.followers");
    }
  });

  it("treats an empty placeholder as unknown", () => {
    expect(() => parseMergeFields("Hi {{}}")).toThrow(UnknownMergeFieldError);
  });
});

describe("renderTemplate — the resolved case", () => {
  it("substitutes every placeholder when all referenced fields are present", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}, love what {{org.name}} is doing in {{org.location}}.",
      values: FULL,
    });
    expect(result).toEqual({
      ok: true,
      text: "Hi Alex, love what Bondi Sourdough is doing in Bondi Beach, NSW.",
    });
  });

  it("joins a text[] field with a comma and a space", () => {
    const result = renderTemplate({ body: "You do {{org.category}}.", values: FULL });
    expect(result).toEqual({ ok: true, text: "You do Bakery, Cafe." });
  });

  it("renders a subject alongside the body when both resolve", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}",
      subject: "A note for {{org.name}}",
      values: FULL,
    });
    expect(result).toEqual({ ok: true, text: "Hi Alex", subject: "A note for Bondi Sourdough" });
  });

  it("omits subject entirely when the template has none", () => {
    const result = renderTemplate({ body: "Hi {{contact.name}}", values: FULL });
    expect("subject" in result).toBe(false);
  });

  it("substitutes literally — a value containing a placeholder is not re-scanned", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}",
      values: { ...FULL, "contact.name": "{{org.name}}" },
    });
    expect(result).toEqual({ ok: true, text: "Hi {{org.name}}" });
  });

  it("ignores values for fields the template does not reference", () => {
    const result = renderTemplate({ body: "Hi {{contact.name}}", values: FULL });
    expect(result).toEqual({ ok: true, text: "Hi Alex" });
  });
});

describe("renderTemplate — the refusal case", () => {
  it("refuses and names the field when a referenced value is null", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}, {{contact.biography}} is great.",
      values: { ...FULL, "contact.biography": null },
    });
    expect(result).toEqual({ ok: false, missing: ["contact.biography"] });
  });

  it("produces NO text at all when a field is missing", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}, {{contact.biography}} is great.",
      values: { ...FULL, "contact.biography": null },
    });
    expect("text" in result).toBe(false);
  });

  it("refuses when the value is absent rather than explicitly null", () => {
    const result = renderTemplate({ body: "Hi {{contact.name}}", values: {} });
    expect(result).toEqual({ ok: false, missing: ["contact.name"] });
  });

  it("names both missing fields, in template order", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}} — {{org.location}} — {{contact.biography}}",
      values: { ...FULL, "contact.biography": null, "org.location": null },
    });
    expect(result).toEqual({ ok: false, missing: ["org.location", "contact.biography"] });
  });

  it("names a missing field once even when referenced twice", () => {
    const result = renderTemplate({
      body: "{{contact.biography}} / {{contact.biography}}",
      values: { "contact.biography": null },
    });
    expect(result).toEqual({ ok: false, missing: ["contact.biography"] });
  });

  it("treats an EMPTY text[] as missing, not as an empty string", () => {
    const result = renderTemplate({
      body: "You do {{org.category}}.",
      values: { ...FULL, "org.category": [] },
    });
    expect(result).toEqual({ ok: false, missing: ["org.category"] });
    expect("text" in result).toBe(false);
  });

  it("treats a text[] of blank entries as missing", () => {
    const result = renderTemplate({
      body: "You do {{org.category}}.",
      values: { ...FULL, "org.category": ["", "  "] },
    });
    expect(result).toEqual({ ok: false, missing: ["org.category"] });
  });

  it("treats a whitespace-only value as missing — a scrape yields these routinely", () => {
    const result = renderTemplate({
      body: "{{contact.biography}}",
      values: { ...FULL, "contact.biography": "  " },
    });
    expect(result).toEqual({ ok: false, missing: ["contact.biography"] });
  });

  it("treats an empty string as missing", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}",
      values: { ...FULL, "contact.name": "" },
    });
    expect(result).toEqual({ ok: false, missing: ["contact.name"] });
  });

  it("fails the whole render when the SUBJECT references a missing field", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}",
      subject: "About {{contact.biography}}",
      values: { ...FULL, "contact.biography": null },
    });
    expect(result).toEqual({ ok: false, missing: ["contact.biography"] });
    expect("text" in result).toBe(false);
    expect("subject" in result).toBe(false);
  });
});

describe("renderTemplate — the authoring-bug case", () => {
  it("refuses an unknown placeholder as unknown, not as missing data", () => {
    const result = renderTemplate({
      body: "Hi {{contact.followers}}",
      values: FULL,
    });
    expect(result).toEqual({ ok: false, unknown: ["contact.followers"] });
    expect("missing" in result).toBe(false);
  });

  it("never renders an unknown placeholder as literal text", () => {
    const result = renderTemplate({ body: "Hi {{contact.followers}}", values: FULL });
    expect("text" in result).toBe(false);
  });

  it("names every unknown token, deduped and in template order", () => {
    const result = renderTemplate({
      body: "{{org.abn}} {{contact.followers}} {{org.abn}}",
      values: FULL,
    });
    expect(result).toEqual({ ok: false, unknown: ["org.abn", "contact.followers"] });
  });

  it("reports unknown ahead of missing — an authoring bug outranks absent data", () => {
    const result = renderTemplate({
      body: "{{org.abn}} {{contact.biography}}",
      values: { ...FULL, "contact.biography": null },
    });
    expect(result).toEqual({ ok: false, unknown: ["org.abn"] });
  });

  it("catches an unknown placeholder in the subject too", () => {
    const result = renderTemplate({
      body: "Hi {{contact.name}}",
      subject: "{{org.abn}}",
      values: FULL,
    });
    expect(result).toEqual({ ok: false, unknown: ["org.abn"] });
  });
});
