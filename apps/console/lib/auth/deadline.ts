/**
 * Bound an awaited promise, rejecting past the deadline.
 *
 * # Why this is its own module
 *
 * It started life in `platform-token.ts`, next to its first caller. It now has
 * three: the refresh path, `/auth/callback`'s store write, and `/auth/logout`'s
 * store delete. Two of those are not refresh, and importing them from
 * `platform-token.ts` would drag React's `cache`, `next/headers`, the `pg` pool
 * and the OIDC client into a route that wants four lines of `Promise.race`.
 * A utility with three unrelated callers belongs beside none of them.
 *
 * # Why it rejects rather than resolving null
 *
 * Rejecting is what unwinds `runTesserixTx` through its ROLLBACK, which is what
 * actually releases the row lock and the pooled connection. Resolving null
 * would COMMIT a transaction that did nothing, which is harmless today and
 * would quietly stop being so if anything were ever added after the call.
 *
 * It also means a hang lands in the same `catch` a thrown error lands in, so
 * every call site degrades identically whether its operation failed or simply
 * never came back.
 *
 * # Why nothing here bounds these operations already
 *
 * `connectionTimeoutMillis` in `lib/db/tesserix.ts` bounds pool ACQUISITION
 * only, and there is no `statement_timeout` anywhere in this stack. A query
 * that has already started can run as long as Postgres lets it.
 *
 * The timer is always cleared, so a fast operation does not hold the event loop
 * open for the remainder of the deadline.
 *
 * `message` defaults to the refresh path's own wording, which is the call site
 * that predates this module and passes only two arguments. A caller bounding a
 * different operation should pass one that says what timed out — the message is
 * what a log line at 2am has to tell the two apart with.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message = "zitadel refresh timed out",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
