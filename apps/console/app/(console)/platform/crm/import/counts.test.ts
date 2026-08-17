import { describe, expect, it } from "vitest";
import { previewDisplayCounts, committedDisplayCounts, matchedRowLabel } from "./counts";

const PREVIEW = { toCreate: 1, matchedExisting: 2, skippedSuppressed: 3, malformed: 4, matchedRows: [] };
const RESULT = {
  importId: "imp1",
  created: 1,
  matchedExisting: 2,
  skippedSuppressed: 3,
  malformed: 4,
  matchedRows: [],
};

describe("previewDisplayCounts / committedDisplayCounts", () => {
  it("both fold parseMalformed into the malformed count the same way", () => {
    // Important 3's regression: preview and commit must report the same
    // malformed count for the same file — not one that remembers the
    // client-side parse malformed count and one that forgets it.
    const preview = previewDisplayCounts(PREVIEW, 5);
    const committed = committedDisplayCounts(RESULT, 5);
    expect(preview.malformed).toBe(9);
    expect(committed.malformed).toBe(9);
    expect(preview.malformed).toBe(committed.malformed);
  });

  it("previewDisplayCounts maps toCreate straight through", () => {
    expect(previewDisplayCounts(PREVIEW, 0)).toEqual({
      toCreate: 1,
      matchedExisting: 2,
      skippedSuppressed: 3,
      malformed: 4,
    });
  });

  it("committedDisplayCounts maps created to toCreate", () => {
    expect(committedDisplayCounts(RESULT, 0)).toEqual({
      toCreate: 1,
      matchedExisting: 2,
      skippedSuppressed: 3,
      malformed: 4,
    });
  });
});

describe("matchedRowLabel", () => {
  it("prefers the name", () => {
    expect(matchedRowLabel({ name: "Bondi Baker", email: "ava@example.com" })).toBe("Bondi Baker");
  });

  it("falls back to email when there is no name", () => {
    expect(matchedRowLabel({ email: "ava@example.com" })).toBe("ava@example.com");
  });

  it("falls back to the Instagram handle when there is no name or email", () => {
    expect(matchedRowLabel({ instagramHandle: "@bondibaker" })).toBe("@bondibaker");
  });
});
