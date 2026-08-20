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

/** Carries the HTTP status when there was one. A 501 means the endpoint is
 *  parked; anything else is a real failure. Losing the status here collapses
 *  that distinction and a parked plane starts reading as broken. */
export class PlatformApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformApiError";
    this.status = status;
  }
}
