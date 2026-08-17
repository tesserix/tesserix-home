import { describe, expect, it } from "vitest";
import { suppressionsState, EMPTY_MESSAGE } from "./page";
import type { SuppressionRow } from "@/lib/db/crm-repo";

const ROW: SuppressionRow = {
  id: "s1",
  email: "ava@example.com",
  instagramHandle: null,
  reason: "unsubscribed",
  createdBy: "ava@tesserix.app",
  createdAt: "2026-08-16T00:00:00.000Z",
};

describe("suppressionsState", () => {
  it("reports empty — not ready — when there is nothing on the list", () => {
    expect(suppressionsState({ error: null, rows: [] })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is at least one row", () => {
    expect(suppressionsState({ error: null, rows: [ROW] })).toEqual({ kind: "ready" });
  });

  it("prefers the error over an empty list", () => {
    // A failed read also has no rows; "nobody is on the list" would tell an
    // operator the list is genuinely empty when the read simply failed —
    // exactly the distinction `[organisation]/page.tsx`'s `detailState` makes
    // for a missing organisation vs. a failed lookup.
    expect(suppressionsState({ error: new Error("boom"), rows: [] }).kind).toBe("error");
  });
});

describe("EMPTY_MESSAGE", () => {
  it("is the copy the page actually ships, exported so a test can assert on it rather than a second copy of it", () => {
    expect(EMPTY_MESSAGE).toBe("Nobody is on the do-not-contact list.");
  });
});
