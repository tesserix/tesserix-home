import { describe, expect, it } from "vitest";
import { detailState, isUuidShaped } from "./page";
import type { OrganisationDetail } from "@/lib/db/crm-repo";

const DETAIL = {
  organisation: { id: "g1", name: "Bondi Baker" },
  contacts: [],
  opportunities: [],
  activities: [],
} as unknown as OrganisationDetail;

describe("detailState", () => {
  it("reports empty — not ready — when the record never arrived", () => {
    expect(detailState({ error: null, detail: null })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is a record", () => {
    expect(detailState({ error: null, detail: DETAIL })).toEqual({ kind: "ready" });
  });

  it("prefers the error over the missing record", () => {
    // A thrown lookup also has no detail; "this record has no details" would
    // tell an operator the organisation is blank when the read simply failed.
    expect(detailState({ error: new Error("boom"), detail: null }).kind).toBe("error");
  });
});

// Minor 10: `crm_organisations.id` is a `uuid` column — a non-UUID path
// segment (a mistyped or hand-edited URL) previously reached the query and
// came back as Postgres error 22P02 ("invalid input syntax for type uuid"),
// which `detailState` has no choice but to read as a generic `error` state.
// That is the wrong outcome for what is actually a 404: the record doesn't
// exist because no record could ever have that id. `isUuidShaped` is the
// route-boundary check that catches this before the query runs at all.
describe("isUuidShaped", () => {
  it("accepts a real uuid", () => {
    expect(isUuidShaped("8b6a7a4a-0000-0000-0000-000000000000")).toBe(true);
  });

  it("accepts a uuid regardless of case", () => {
    expect(isUuidShaped("8B6A7A4A-0000-0000-0000-000000000000")).toBe(true);
  });

  it("rejects a non-uuid path segment — the case that used to hit Postgres error 22P02", () => {
    expect(isUuidShaped("nope")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isUuidShaped("")).toBe(false);
  });

  it("rejects a uuid-length string with an invalid character", () => {
    expect(isUuidShaped("8b6a7a4a-0000-0000-0000-00000000000z")).toBe(false);
  });
});
