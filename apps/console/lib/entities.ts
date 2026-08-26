import { PlatformApiError } from "./platform-api";

/**
 * One product's §3.4 entity records — the shape behind the product rail's
 * index pages and, later, the estate Directory and command palette.
 *
 * Deliberately NOT the estate tenant directory (`lib/tenants.ts`). That reads
 * the same contract endpoint for the `tenants` type, but fans out and merges
 * because a tenant means the same thing everywhere. An entity type does not:
 * `users` in one product and `users` in another are different populations, so
 * this reads exactly one product and the caller names it.
 */

export interface EntityRecord {
  readonly id: string;
  /** Which product this came from. Required — two products' `users` are
   *  different people, and a row without its origin cannot be rendered. */
  readonly source: string;
  /** The product-defined type this row came from, echoed by the API. */
  readonly type: string;
  readonly label: string;
  /** ISO 8601 with an offset per §4.3, kept as the string the product sent.
   *  Optional: not every entity type has a creation instant that means
   *  anything. */
  readonly createdAt?: string;
}

export interface EntityPagination {
  readonly page: number;
  readonly limit: number;
  /**
   * The PRODUCT's count of matching records, which may far exceed the page
   * shown — Kora reports 6421 foods. Required, because without it a first page
   * and a whole result set look identical.
   */
  readonly total: number;
}

export interface EntityPage {
  readonly data: readonly EntityRecord[];
  readonly pagination: EntityPagination;
}

function fail(message: string): never {
  throw new PlatformApiError(`entities: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function counter(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${path} is not a non-negative whole number`);
  }
  return value;
}

function parseRecord(value: unknown, path: string): EntityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: str(row.id, `${path}.id`),
    // Required rather than defaulted: a wrong Source column is worse than a
    // failed read, and this surface will eventually show more than one product.
    source: str(row.source, `${path}.source`),
    type: str(row.type, `${path}.type`),
    label: str(row.label, `${path}.label`),
    createdAt: optionalStr(row.created_at, `${path}.created_at`),
  };
}

/**
 * Parse the platform API's `/v1/entities/{type}` payload.
 *
 * `pagination.total` is required rather than defaulted to `data.length`. The
 * page bound is small and the real total is not — defaulting would quietly
 * claim the first 100 foods are all 6421 of them, which is the same class of
 * false completeness the inbox's `failures` guard prevents.
 */
export function parseEntities(json: unknown): EntityPage {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!Array.isArray(body.data)) fail("data is not an array");
  const pagination = body.pagination;
  if (typeof pagination !== "object" || pagination === null || Array.isArray(pagination)) {
    fail("pagination is missing");
  }
  const counters = pagination as Record<string, unknown>;

  return {
    data: body.data.map((row, i) => parseRecord(row, `data[${i}]`)),
    pagination: {
      page: counter(counters.page, "pagination.page"),
      limit: counter(counters.limit, "pagination.limit"),
      total: counter(counters.total, "pagination.total"),
    },
  };
}
