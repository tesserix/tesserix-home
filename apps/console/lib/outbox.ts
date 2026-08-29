// Imported from `./platform-api-error`, NOT from `./platform-api` — see the
// header of `./platform-api-error` and `./lib/audit.ts` for the failure mode
// this avoids: a value import of `PlatformApiError` from `./platform-api` is
// what dragged `pg` into the browser bundle and broke a production build.
import { PlatformApiError } from "./platform-api-error";
// `readOutbox` below DOES import a runtime value from `./platform-api`
// (`platformApiOrigin`/`platformRequestWithMeta`), unlike `./lib/audit.ts` and
// `./lib/inbox.ts`, which keep the parser entirely separate from the fetch.
// That is safe ONLY because nothing else in this file is imported as a
// runtime VALUE by a client component — the client-side table
// (`outbox-table.tsx`) imports exclusively `import type { ... } from
// "@/lib/outbox"`, which TypeScript erases completely, so this file's
// dependency on `./platform-api` never reaches the client bundle. If a future
// change adds a runtime helper here (a `sourceLabel`-style formatter, say)
// that a client component needs, move the platform-api call out of this file
// first — see `./lib/audit.ts`'s header for why doing it the other way round
// broke the build once already.

/**
 * The estate outbox — every federating product's `outbox_events` rows, read
 * through `GET /v1/outbox` behind the platform API.
 *
 * ONE transport, like `./lib/tenants.ts` and unlike `./lib/audit.ts`: this
 * surface has no apps/web predecessor to fall back to, so unsetting
 * `PLATFORM_API_ORIGIN` does not roll it back to anything — it simply turns
 * the surface off, and `readOutbox` says so with a 501 rather than pretending
 * to read a source that does not exist.
 *
 * # The three shapes `GET /v1/outbox` answers with, and why they must render
 *   differently
 *
 * - **501, with no `events` key at all.** Nothing is federated —
 *   `FEDERATION_MARK8LY_ENDPOINTS` (or any product's) names no outbox
 *   implementer, so `SlugsImplementing("outbox")` on the platform API is
 *   empty. This is production's state today. `readOutbox` never calls
 *   `parseEstateOutbox` on this path — it rejects with a `PlatformApiError`
 *   carrying `status: 501`, which the page maps to
 *   `instrumentation-unavailable`, never to an empty table.
 * - **200 with `events: []`, `not_implemented: []`.** Federated, and every
 *   product that answered genuinely has nothing to report. A real, calm
 *   answer.
 * - **200 with `events: []`, `not_implemented` populated.** Federated, but
 *   every configured product answered 501 for THIS request — a live
 *   "nothing to report here" statement from a product that has otherwise
 *   declared the endpoint, not a broken source (see `domain.Page` in
 *   `platform-api/internal/modules/outbox/internal/domain/event.go`). This is
 *   NOT the same claim as the middle case, and rendering it identically would
 *   be exactly the failure this task exists to prevent: an operator reading
 *   an empty table cannot tell "the estate's outbox is clean" from "nobody
 *   answered". The page's job is to keep these visually distinct even though
 *   both are zero-row 200s.
 */

/**
 * One `outbox_events` row, from any federated product.
 *
 * Field names and optionality mirror `domain.Event` in
 * `platform-api/internal/modules/outbox/internal/domain/event.go` exactly —
 * that struct is the wire contract, not this one, so a field renamed there
 * without a matching change here is a silent decode mismatch rather than a
 * compile error anywhere.
 */
export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly status: string;
  readonly createdAt: string;
  /**
   * ABSENT for a published row, by design — a settled row has no waiting
   * time, and a number that grew forever there would read as "stuck" beside a
   * genuinely stuck row. Preserved as absence here (`undefined`), never
   * defaulted to `0` and never derived from `createdAt`. Rendering it is the
   * table's job, not this parser's.
   */
  readonly ageSeconds?: number;
  readonly publishedAt?: string;
  /**
   * OPAQUE. `outbox_events.error` has no CHECK constraint and the operator
   * requeue path is a raw UPDATE, so the values mark8ly writes are not the
   * only ones observable here. Never narrowed to a union, never switched on —
   * an unrecognised string is preserved verbatim and rendered as itself.
   */
  readonly error?: string;
  /**
   * REQUIRED on every row, and stamped by the platform API from the slug the
   * call was MADE to, never read from the row's own body. A merged list from
   * two products whose rows are indistinguishable is not a governance
   * surface, and a wrong Source column is worse than a failed read.
   */
  readonly source: string;
}

/** One product that could not be read. */
export interface OutboxSourceFailure {
  readonly source: string;
  readonly message: string;
}

export interface EstateOutbox {
  readonly events: readonly OutboxEvent[];
  readonly failures: readonly OutboxSourceFailure[];
  /**
   * Every product that DECLARED the outbox endpoint but answered 501 for this
   * particular request. See the module doc above for why this must stay
   * apart from both `failures` and a genuinely empty `events`.
   */
  readonly notImplemented: readonly string[];
}

function fail(message: string): never {
  throw new PlatformApiError(`outbox: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

/** An optional text field. `null` is accepted as "absent" because that is
 *  what a nullable column and a Go `*string` zero value both serialise to. */
function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

/**
 * An optional number field, for `age_seconds`.
 *
 * `0` is a real, valid age (a row created this instant) and must round-trip
 * as `0`, not as absent — only `null`/`undefined` mean "no waiting time to
 * report", per `domain.Event.AgeSeconds`'s own doc comment.
 */
function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} is not a number`);
  return value;
}

function parseEvent(value: unknown, path: string): OutboxEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: str(row.id, `${path}.id`),
    tenantId: str(row.tenant_id, `${path}.tenant_id`),
    aggregate: str(row.aggregate, `${path}.aggregate`),
    aggregateId: str(row.aggregate_id, `${path}.aggregate_id`),
    eventType: str(row.event_type, `${path}.event_type`),
    status: str(row.status, `${path}.status`),
    createdAt: str(row.created_at, `${path}.created_at`),
    ageSeconds: optionalNumber(row.age_seconds, `${path}.age_seconds`),
    publishedAt: optionalStr(row.published_at, `${path}.published_at`),
    // Opaque — read as an optional string and nothing more. Never validated
    // against a closed set: the operator requeue path is a raw UPDATE, so a
    // value this build has never seen is expected, not a parse failure.
    error: optionalStr(row.error, `${path}.error`),
    // Required, for the same reason `failures` below is required rather than
    // defaulted: a row whose origin this surface does not know cannot be
    // attributed honestly, and a wrong Source column is worse than a failed
    // read.
    source: str(row.source, `${path}.source`),
  };
}

function parseFailure(value: unknown, path: string): OutboxSourceFailure {
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
 * Parse the platform API's `GET /v1/outbox` body — `domain.Page` verbatim.
 *
 * Strict, like every other estate reader in this directory: a renamed field
 * upstream must surface as a thrown `PlatformApiError`, never as a ledger
 * quietly missing its status column or its source. A half-built row is worse
 * than a read that says it failed.
 *
 * `failures` and `not_implemented` are BOTH required, not defaulted to `[]`.
 * A body without either is a response this surface cannot prove complete, and
 * defaulting either would let "some products did not answer" render
 * identically to "the estate's outbox is genuinely clean" — the exact
 * distinction the module doc above exists to preserve.
 */
export function parseEstateOutbox(json: unknown): EstateOutbox {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!Array.isArray(body.events)) fail("events is not an array");
  if (!Array.isArray(body.failures)) fail("failures is missing");
  if (!Array.isArray(body.not_implemented)) fail("not_implemented is missing");

  return {
    events: body.events.map((event, i) => parseEvent(event, `events[${i}]`)),
    failures: body.failures.map((failure, i) => parseFailure(failure, `failures[${i}]`)),
    notImplemented: body.not_implemented.map((source, i) =>
      str(source, `not_implemented[${i}]`),
    ),
  };
}

/**
 * Read the estate outbox.
 *
 * No apps/web fallback — this surface never existed there, so unsetting
 * `PLATFORM_API_ORIGIN` does not roll anything back, it switches the surface
 * off. `fetchEstateTenants` in `./platform-api.ts` states the same reasoning
 * at more length for the same shape of surface.
 *
 * `platformRequestWithMeta` throws on any non-2xx, so the 501 the platform
 * API answers when no product implements the outbox contract arrives here as
 * a `PlatformApiError` carrying `status: 501` — never as a resolved, empty
 * `EstateOutbox`. That is what lets the page distinguish "not federated" from
 * "federated and empty" (see the module doc above).
 */
export async function readOutbox(): Promise<EstateOutbox> {
  const { platformApiOrigin, platformRequestWithMeta } = await import("./platform-api");

  if (!platformApiOrigin()) {
    throw new PlatformApiError(
      "outbox: PLATFORM_API_ORIGIN is not set, and this surface has no apps/web predecessor to fall back to",
      501,
    );
  }

  const { data } = await platformRequestWithMeta("outbox", "/v1/outbox");
  return parseEstateOutbox(data);
}
