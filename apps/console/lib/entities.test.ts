import { describe, expect, it } from "vitest";

import { parseEntities } from "./entities";
// Named explicitly rather than a bare `{ ..., pagination: {...} }` literal:
// `entities` nests pagination INSIDE `data`, unlike `koraaimetrics` (see
// `kora-ai-metrics.test.ts`), and this is the one place that distinction is
// pinned for this parser — see the helper's own doc comment for why (#421).
import { paginationInsideData } from "./test-support/pagination-envelope";

/** The shape platform-api's entities module emits, as its Go tests pin it. */
const body = paginationInsideData(
  {
    data: [
      {
        id: "kora:528ea893",
        source: "kora",
        type: "foods",
        label: "Veg kolhapuri",
        created_at: "2026-08-22T07:16:52Z",
      },
    ],
  },
  { page: 1, limit: 100, total: 6421 },
) as { data: unknown[]; pagination: { page: number; limit: number; total: number } };

describe("parseEntities", () => {
  it("reads the platform API's shape", () => {
    const page = parseEntities(body);
    expect(page.data[0]?.label).toBe("Veg kolhapuri");
    expect(page.data[0]?.source).toBe("kora");
    expect(page.pagination.total).toBe(6421);
  });

  // The page bound is small and the real total is not. Defaulting would
  // quietly claim the first 100 foods are all 6421 of them.
  it("refuses a body with no pagination rather than defaulting it", () => {
    expect(() => parseEntities({ data: [] })).toThrow(/pagination/);
  });

  it("refuses a non-whole or negative counter", () => {
    expect(() =>
      parseEntities(paginationInsideData(body, { page: 1, limit: 100, total: -1 })),
    ).toThrow(/total/);
    expect(() =>
      parseEntities(paginationInsideData(body, { page: 1.5, limit: 100, total: 1 })),
    ).toThrow(/page/);
  });

  // A wrong Source column is worse than a failed read, and this surface will
  // eventually show more than one product.
  it("refuses a row with no source", () => {
    const { source: _dropped, ...noSource } = body.data[0] as Record<string, unknown>;
    expect(() => parseEntities({ ...body, data: [noSource] })).toThrow(/source/);
  });

  // Not every entity type has a creation instant that means anything.
  it("accepts a row with no created_at", () => {
    const { created_at: _dropped, ...noDate } = body.data[0] as Record<string, unknown>;
    const page = parseEntities({ ...body, data: [noDate] });
    expect(page.data[0]?.createdAt).toBeUndefined();
  });

  it("names the offending path so the fix does not require a search", () => {
    const firstRow = body.data[0] as Record<string, unknown>;
    expect(() => parseEntities({ ...body, data: [{ ...firstRow, label: 42 }] })).toThrow(
      /data\[0\]\.label/,
    );
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseEntities(null)).toThrow();
    expect(() => parseEntities([])).toThrow();
    expect(() => parseEntities({ data: "nope", pagination: body.pagination })).toThrow(/data/);
  });

  it("accepts an empty page, because zero rows is still a page", () => {
    const page = parseEntities(
      paginationInsideData({ data: [] }, { page: 1, limit: 100, total: 0 }),
    );
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
  });
});
