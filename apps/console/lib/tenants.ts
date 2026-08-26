// Imported from `./platform-api-error`, NOT from `./platform-api`, for the
// reason audit.ts records at length: this module is reachable from a
// `"use client"` component, `PlatformApiError` is a value, and a value import
// from `./platform-api` is what dragged `pg` into the browser bundle and broke
// a production build. Point it back and it breaks again.
import { PlatformApiError } from "./platform-api-error";

/**
 * One tenant, from any product that has them.
 *
 * Mirrors the platform API's `domain.Tenant` wire shape exactly. `source` and
 * `id` arrive already stamped and namespaced by the server — the console never
 * derives either, because the server stamps them from the slug it CALLED
 * rather than from anything the product's body claimed.
 */
export interface EstateTenant {
  /** Namespaced as `<source>:<id>`. Two products both returning `1` are
   * otherwise indistinguishable in a merged list. */
  readonly id: string;
  readonly name: string;
  readonly ownerEmail?: string;
  /**
   * The PRODUCT's own status vocabulary, rendered verbatim.
   *
   * Deliberately not narrowed to a union and not translated. "active" means
   * whatever the product means by it, and a console-side mapping table would
   * be a second vocabulary that drifts from the first — the same argument
   * `sourceLabel` makes for rendering an unknown source id unchanged.
   */
  readonly status: string;
  readonly createdAt?: string;
  readonly source: string;
}

/** One product that could not be read. */
export interface TenantSourceFailure {
  readonly source: string;
  readonly message: string;
}

export interface EstateTenants {
  readonly tenants: readonly EstateTenant[];
  readonly failures: readonly TenantSourceFailure[];
}

function fail(message: string): never {
  throw new PlatformApiError(`tenants: ${message}`);
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

function parseTenant(value: unknown, path: string): EstateTenant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    // Required, all four. A tenant row without an id cannot be keyed, without
    // a name cannot be read, without a status cannot be acted on, and without
    // a source cannot be attributed — and a directory that renders
    // "undefined" in any of those columns is worse than one that says it
    // could not be read.
    id: str(row.id, `${path}.id`),
    name: str(row.name, `${path}.name`),
    status: str(row.status, `${path}.status`),
    source: str(row.source, `${path}.source`),
    ownerEmail: optionalStr(row.owner_email, `${path}.owner_email`),
    createdAt: optionalStr(row.created_at, `${path}.created_at`),
  };
}

function parseFailure(value: unknown, path: string): TenantSourceFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    source: str(row.source, `${path}.source`),
    message: str(row.message, `${path}.message`),
  };
}

/**
 * Parse the estate tenant directory.
 *
 * Strict, like `lib/audit.ts` and `lib/tickets.ts`: a renamed field upstream
 * must surface as a failure rather than as a table of blank cells. A directory
 * quietly missing its status column is worse than one that says it could not
 * be read, because only the second gets fixed.
 *
 * `failures` is REQUIRED, not defaulted to `[]`. A body without it is a
 * different endpoint or an older deployment, and treating its absence as "no
 * failures" would assert completeness this surface cannot verify — the one
 * claim a directory must never make by accident. An operator acting on a list
 * they believe is the whole estate, when one product silently dropped out, is
 * the failure mode this guards.
 */
export function parseEstateTenants(json: unknown): EstateTenants {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!Array.isArray(body.tenants)) fail("tenants is not an array");
  if (!Array.isArray(body.failures)) fail("failures is not an array");

  return {
    tenants: body.tenants.map((row, i) => parseTenant(row, `tenants[${i}]`)),
    failures: body.failures.map((row, i) => parseFailure(row, `failures[${i}]`)),
  };
}

/**
 * The product a namespaced id came from, and the product's own id within it.
 *
 * Split on the FIRST separator only: a product's own id may contain a colon
 * (a UUID does not, but a slug-shaped or composite key can), and splitting on
 * the last would silently reattribute those rows.
 */
export function splitTenantId(id: string): { source: string; productId: string } {
  const at = id.indexOf(":");
  if (at === -1) return { source: "", productId: id };
  return { source: id.slice(0, at), productId: id.slice(at + 1) };
}
