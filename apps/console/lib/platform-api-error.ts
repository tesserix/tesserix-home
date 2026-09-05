/**
 * `PlatformApiError`, and nothing else.
 *
 * # WHY THIS CLASS LIVES ALONE, AWAY FROM `platform-api.ts`
 *
 * It is a class used as a VALUE — thrown, and narrowed with `instanceof` — so
 * every module that touches it emits a real runtime import, not a type-only
 * one that disappears at compile time. That made it a rope: a `"use client"`
 * component importing it from `lib/platform-api.ts` dragged in
 * `platform-api.ts` -> `auth/platform-token.ts` -> `db/tesserix.ts` -> `pg`,
 * and the Postgres driver landed in the BROWSER bundle. The build died with
 * `Module not found: Can't resolve 'net' / 'dns' / 'fs' / 'tls'` from deep
 * inside `node_modules/pg`, naming nothing an operator could act on.
 *
 * It only started failing when `platform-token.ts` moved from reading the
 * session cookie to reading Postgres; before that the chain ended harmlessly.
 * The rope had been there the whole time.
 *
 * So: this module has NO imports, and it must stay that way. Anything a client
 * component needs — `lib/tickets.ts`, `lib/audit.ts`, the parsers — imports the
 * error from HERE, not from `lib/platform-api.ts`, and the client's path to the
 * server-only code is cut.
 *
 * `lib/platform-api.ts` re-exports this exact binding, so there is still
 * EXACTLY ONE class identity in the process. Do not solve an import cycle or a
 * bundling complaint by declaring a second copy of this class anywhere:
 * `instanceof` would start returning false across the boundary, silently, and
 * every "the endpoint is parked" check that keys off `status === 501` would
 * quietly become "this is broken".
 */

/** Options a thrower may attach beyond the standard `cause`. */
export interface PlatformApiErrorOptions extends ErrorOptions {
  /**
   * True ONLY for "this session has no usable operator token row" — a valid
   * session that simply cannot authenticate to the platform API, which signing
   * in again fixes.
   *
   * A marker rather than a code string, matching `MalformedCursorError`'s
   * `malformedCursor` — one spelling for "a structural reader can test this",
   * not two. It is read structurally (see `toSurfaceError`), never with
   * `instanceof`, because the reader must stay free of `lib/` imports and an
   * `instanceof` across a bundler boundary can fail silently.
   *
   * It must NOT be set for a 401, a 403, a 5xx, or an unconfigured origin.
   * Those are different problems with different remedies, and collapsing them
   * into "sign in again" is the same unactionable answer this marker exists to
   * replace.
   */
  noOperatorToken?: boolean;
  /**
   * The platform API's own `error.code` — `NOT_IMPLEMENTED`,
   * `VALIDATION_FAILED`, `EXTERNAL_SERVICE_ERROR`, `SERVICE_UNAVAILABLE`,
   * `BAD_REQUEST`, … — carried structurally instead of only being spelled into
   * `message`.
   *
   * It exists because the STATUS does not separate the answers an operator
   * must act on differently. `httpx.ExternalService` and `httpx.Unavailable`
   * are both 503: one means the product answered and refused, the other means
   * it was never reached, and the operator's next step differs. Recovering
   * that from the message text would be a parser over another service's
   * sentence, which is exactly the kind of coupling this field removes.
   *
   * Optional, and every existing reader ignores it: `toSurfaceError` still
   * decides on `status` alone, so nothing that worked before behaves
   * differently.
   */
  code?: string;
}

/** Carries the HTTP status when there was one. A 501 means the endpoint is
 *  parked; anything else is a real failure. Losing the status here collapses
 *  that distinction and a parked plane starts reading as broken. */
export class PlatformApiError extends Error {
  readonly status?: number;
  readonly noOperatorToken: boolean;
  /** The envelope's `error.code`, when the failure carried one. See
   *  `PlatformApiErrorOptions.code` for why the status is not enough. */
  readonly code?: string;

  constructor(message: string, status?: number, options?: PlatformApiErrorOptions) {
    super(message, options);
    this.name = "PlatformApiError";
    this.status = status;
    this.noOperatorToken = options?.noOperatorToken === true;
    this.code = options?.code;
  }
}
