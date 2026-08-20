/**
 * What `server-only` resolves to under Vitest.
 *
 * `lib/db/tesserix.ts` and the two operator-token modules import `server-only`
 * so that a `"use client"` component reaching them fails `next build` loudly —
 * with the offending import chain named — instead of surfacing as `Module not
 * found: Can't resolve 'net'` from deep inside `node_modules/pg`.
 *
 * A bundler picks the package's `react-server` export (an empty module) on the
 * server side and its `default` export (which throws on import, by design) on
 * the client. Vitest is neither: there is no `react-server` condition, so Node
 * takes the throwing entry and every server module under test fails to load.
 * The package's `exports` map has only `.`, so it cannot be deep-imported
 * either — hence this stub rather than an alias to `server-only/empty.js`.
 *
 * Empty on purpose. It stands in only for the tests; `next build` still
 * resolves the real package, which is where the guard has to work.
 */
export {};
