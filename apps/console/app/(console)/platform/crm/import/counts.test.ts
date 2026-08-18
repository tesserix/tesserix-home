import { describe, expect, it } from "vitest";
import {
  previewDisplayCounts,
  committedDisplayCounts,
  matchedRowLabel,
  visibleMatchedRows,
  MATCHED_ROWS_DISPLAY_LIMIT,
} from "./counts";
import type { ImportRow } from "@/lib/crm";

const PREVIEW = { toCreate: 1, matchedExisting: 2, skippedSuppressed: 3, malformed: 4, matchedRows: [] };
const RESULT = {
  importId: "imp1",
  created: 1,
  matchedExisting: 2,
  skippedSuppressed: 3,
  malformed: 4,
  droppedWebsiteUrls: 0,
  droppedCountCells: 0,
  droppedMetadataCells: 0,
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
      droppedWebsiteUrls: null,
      droppedCountCells: null,
      droppedMetadataCells: null,
    });
  });

  it("committedDisplayCounts maps created to toCreate", () => {
    expect(committedDisplayCounts(RESULT, 0)).toEqual({
      toCreate: 1,
      matchedExisting: 2,
      skippedSuppressed: 3,
      malformed: 4,
      droppedWebsiteUrls: 0,
      droppedCountCells: 0,
      droppedMetadataCells: 0,
    });
  });
});

describe("the dropped-cell counts a preview cannot know", () => {
  it("reports every drop counter as null on a preview", () => {
    // `previewImport` writes nothing, so it drops nothing. Showing a zero
    // beside a preview would assert a fact about an import that has not
    // happened — the card renders these cells only when they are numbers.
    const preview = previewDisplayCounts(PREVIEW, 0);
    expect(preview.droppedWebsiteUrls).toBeNull();
    expect(preview.droppedCountCells).toBeNull();
    expect(preview.droppedMetadataCells).toBeNull();
  });

  it("carries the committed drop counters through unchanged", () => {
    const committed = committedDisplayCounts(
      { ...RESULT, droppedCountCells: 3, droppedMetadataCells: 2 },
      0,
    );
    expect(committed.droppedCountCells).toBe(3);
    expect(committed.droppedMetadataCells).toBe(2);
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

function rows(count: number): ImportRow[] {
  return Array.from({ length: count }, (_, i) => ({ email: `row${i}@example.com` }));
}

describe("visibleMatchedRows", () => {
  // Minor (review round 2): at the row cap, an all-matched import produces
  // a 500-item list — capped, with the overflow named rather than rendered.
  it("returns every row unchanged when under the limit", () => {
    const input = rows(3);
    expect(visibleMatchedRows(input)).toEqual({ visible: input, more: 0 });
  });

  it("returns exactly the limit with more: 0 at the boundary", () => {
    const input = rows(MATCHED_ROWS_DISPLAY_LIMIT);
    const result = visibleMatchedRows(input);
    expect(result.visible).toHaveLength(MATCHED_ROWS_DISPLAY_LIMIT);
    expect(result.more).toBe(0);
  });

  it("truncates to the limit and reports how many more, over the boundary", () => {
    const input = rows(MATCHED_ROWS_DISPLAY_LIMIT + 7);
    const result = visibleMatchedRows(input);
    expect(result.visible).toHaveLength(MATCHED_ROWS_DISPLAY_LIMIT);
    expect(result.more).toBe(7);
  });
});
