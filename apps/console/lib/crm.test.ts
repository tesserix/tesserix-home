import { describe, expect, it } from "vitest";
import {
  CRM_STAGES,
  isCrmStage,
  isCrmActivityKind,
  isHumanActivityKind,
  isUsableImportRow,
  parseImportCsv,
  boundFilename,
  MAX_IMPORT_ROWS,
  validateTotalRows,
  MAX_TOTAL_ROWS,
} from "./crm";

describe("crm vocabulary", () => {
  it("lists the five stages in pipeline order", () => {
    expect([...CRM_STAGES]).toEqual([
      "new", "contacted", "qualified", "won", "lost",
    ]);
  });

  it("rejects a stage that is not in the set", () => {
    // Guards the guard: a predicate returning true for everything would pass
    // every other assertion in this file.
    expect(isCrmStage("won")).toBe(true);
    expect(isCrmStage("converted")).toBe(false);
  });
});

describe("isHumanActivityKind", () => {
  it("accepts every kind an operator can author directly", () => {
    for (const kind of ["note", "dm_sent", "dm_received", "email_sent", "email_received", "call"]) {
      expect(isHumanActivityKind(kind)).toBe(true);
    }
  });

  // The point of this predicate: `stage_change` and `assigned` are valid
  // `CrmActivityKind`s (isCrmActivityKind accepts them) but system-authored
  // ones, so an operator-facing "log an activity" action must reject them
  // even though the broader kind check would let them through.
  it("rejects the system-authored kinds even though isCrmActivityKind accepts them", () => {
    expect(isCrmActivityKind("stage_change")).toBe(true);
    expect(isCrmActivityKind("assigned")).toBe(true);
    expect(isHumanActivityKind("stage_change")).toBe(false);
    expect(isHumanActivityKind("assigned")).toBe(false);
  });

  it("rejects a value that is not an activity kind at all", () => {
    expect(isHumanActivityKind("carrier_pigeon")).toBe(false);
  });
});

describe("isUsableImportRow", () => {
  it("accepts a row identified by email alone", () => {
    expect(isUsableImportRow({ email: "ava@example.com" })).toBe(true);
  });

  it("accepts a row identified by Instagram handle alone", () => {
    expect(isUsableImportRow({ instagramHandle: "@bondibaker" })).toBe(true);
  });

  it("accepts a row identified by name alone", () => {
    expect(isUsableImportRow({ name: "Bondi Baker" })).toBe(true);
  });

  it("rejects a row with nothing to identify who it is about", () => {
    expect(isUsableImportRow({ phone: "0400 000 000" })).toBe(false);
  });

  it("rejects a row whose only identifying fields are blank strings", () => {
    // Guards the guard: a CSV cell of pure whitespace must not count as
    // "present" just because the key exists.
    expect(isUsableImportRow({ name: "   ", email: "" })).toBe(false);
  });
});

describe("parseImportCsv", () => {
  it("parses a simple row into an ImportRow", () => {
    const { rows, malformed } = parseImportCsv(
      "name,email,instagram,phone,website,location\n" +
        "Bondi Baker,ava@example.com,@bondibaker,0400000000,https://bondi.example,Sydney",
    );
    expect(malformed).toBe(0);
    expect(rows).toEqual([
      {
        name: "Bondi Baker",
        email: "ava@example.com",
        instagramHandle: "@bondibaker",
        phone: "0400000000",
        websiteUrl: "https://bondi.example",
        location: "Sydney",
      },
    ]);
  });

  it("trims stray whitespace from every cell", () => {
    // The reason this matters: a suppression lookup normalises the same way
    // (crm-repo.ts's isSuppressed), and CSV exports routinely carry leading
    // or trailing spaces around cells.
    const { rows } = parseImportCsv("name,email\n  Bondi Baker  ,  ava@example.com  ");
    expect(rows).toEqual([{ name: "Bondi Baker", email: "ava@example.com" }]);
  });

  it("splits category and tags on semicolons", () => {
    const { rows } = parseImportCsv(
      "name,category,tags\nBondi Baker,bakery; cafe,warm lead; instagram",
    );
    expect(rows).toEqual([
      { name: "Bondi Baker", category: ["bakery", "cafe"], tags: ["warm lead", "instagram"] },
    ]);
  });

  it("honours quoted cells containing a comma", () => {
    const { rows } = parseImportCsv(
      'name,location\n"Bondi Baker","Sydney, NSW"',
    );
    expect(rows).toEqual([{ name: "Bondi Baker", location: "Sydney, NSW" }]);
  });

  it("ignores columns it does not recognise", () => {
    const { rows } = parseImportCsv("name,unknown_column\nBondi Baker,whatever");
    expect(rows).toEqual([{ name: "Bondi Baker" }]);
  });

  it("skips a fully blank line without counting it as malformed", () => {
    const { rows, malformed } = parseImportCsv("name,email\nBondi Baker,ava@example.com\n\n   \n");
    expect(rows).toHaveLength(1);
    expect(malformed).toBe(0);
  });

  it("counts a row with nothing identifying as malformed, not silently dropped", () => {
    const { rows, malformed } = parseImportCsv(
      "name,email,phone\nBondi Baker,ava@example.com,0400000000\n,,0499999999",
    );
    expect(rows).toHaveLength(1);
    expect(malformed).toBe(1);
  });

  it("returns no rows and no malformed count for a header-only file", () => {
    expect(parseImportCsv("name,email")).toEqual({ rows: [], malformed: 0 });
  });

  it("returns nothing for an empty file", () => {
    expect(parseImportCsv("")).toEqual({ rows: [], malformed: 0 });
  });
});

describe("boundFilename", () => {
  // Minor: an operator-supplied filename flows into an audit `target` and
  // `crm_imports.filename` — untrusted input from a network-reachable
  // action, same as any other cell in the file, and must be bounded before
  // either of those.
  it("trims whitespace", () => {
    expect(boundFilename("  leads.csv  ")).toBe("leads.csv");
  });

  it("truncates a filename longer than the cap", () => {
    const long = "a".repeat(400) + ".csv";
    const bounded = boundFilename(long);
    expect(bounded).toHaveLength(255);
    expect(bounded).toBe(long.slice(0, 255));
  });

  it("returns undefined for an absent filename", () => {
    expect(boundFilename(undefined)).toBeUndefined();
  });

  it("returns undefined for a filename that is only whitespace", () => {
    expect(boundFilename("   ")).toBeUndefined();
  });
});

describe("MAX_IMPORT_ROWS", () => {
  it("is a positive, finite cap", () => {
    expect(MAX_IMPORT_ROWS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_IMPORT_ROWS)).toBe(true);
  });
});

describe("validateTotalRows", () => {
  // Important 2 (review round 2), Ruling 26 (review round 3): totalRows is
  // a server-action parameter — untrusted input reaching
  // `crm_imports.row_count`, an `integer NOT NULL` column with no CHECK —
  // exactly like `filename` (`boundFilename`). Round 3 changed the
  // response from silent correction to refusal: a clamped value still fed
  // the audit record, so a capability-gated operator could plant a false
  // audit summary with no error and no trace.
  it("accepts a sane value", () => {
    expect(validateTotalRows(12, 10)).toBeUndefined();
  });

  it("accepts the committed row count itself (the floor)", () => {
    expect(validateTotalRows(10, 10)).toBeUndefined();
  });

  it("accepts MAX_TOTAL_ROWS itself (the ceiling)", () => {
    expect(validateTotalRows(MAX_TOTAL_ROWS, 10)).toBeUndefined();
  });

  it("rejects a fractional value", () => {
    expect(validateTotalRows(12.9, 10)).toBeDefined();
  });

  it("rejects a value smaller than the rows actually being committed", () => {
    // totalRows can't be smaller than the batch it's describing — a caller
    // passing a bogus low value is a bug worth surfacing, not smoothing
    // into an honest-looking floor.
    expect(validateTotalRows(3, 10)).toBeDefined();
  });

  it("rejects a value larger than MAX_TOTAL_ROWS, instead of forwarding it toward an integer-column overflow", () => {
    expect(validateTotalRows(1e10, 10)).toBeDefined();
    expect(validateTotalRows(MAX_TOTAL_ROWS + 1, 10)).toBeDefined();
  });

  it("rejects a negative value", () => {
    expect(validateTotalRows(-5, 10)).toBeDefined();
  });

  it("rejects NaN or Infinity", () => {
    expect(validateTotalRows(Number.NaN, 10)).toBeDefined();
    expect(validateTotalRows(Number.POSITIVE_INFINITY, 10)).toBeDefined();
  });

  it("MAX_TOTAL_ROWS is comfortably above MAX_IMPORT_ROWS but nowhere near Postgres's integer range", () => {
    expect(MAX_TOTAL_ROWS).toBeGreaterThan(MAX_IMPORT_ROWS);
    expect(MAX_TOTAL_ROWS).toBeLessThan(2 ** 31 - 1);
  });
});
