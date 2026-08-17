import { describe, expect, it } from "vitest";
import {
  CRM_STAGES,
  isCrmStage,
  isCrmActivityKind,
  isHumanActivityKind,
  isUsableImportRow,
  parseImportCsv,
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
