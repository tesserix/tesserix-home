// Pure display logic pulled out of users-table.tsx so it is directly
// testable. vitest.config.ts's `include` is `app/**/*.test.ts` — it cannot
// discover a `.test.tsx` file, and users-table.tsx's exported component
// itself is never invoked as a function by page.test.ts (it only walks
// `<UsersTable items={...} />` as an unexpanded React element), so anything
// left inside the .tsx file has no path to a running test. This module is
// the only shape the harness can exercise directly.

/**
 * Formats an ISO date string for a table cell, or "—" for `null`/invalid
 * input. Every date-bearing column on this page (Signed up, Onboarded,
 * First log, Last write) routes through this, so its guard against `null`
 * and against an unparseable string is exercised on every row — a raw
 * `new Date(iso).toLocaleDateString()` would render "Invalid Date" in a
 * table an operator is reading for activation signal.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The "Ever logged" column's derivation. Deliberately keyed off `log_count`,
 * not off `first_log`/`last_write` presence — `log_count` is the same field
 * the API's own `ever_logged` summary tally is built from, so the row-level
 * and strip-level figures stay consistent by construction rather than by two
 * independent implementations agreeing by luck.
 */
export function everLogged(logCount: number): boolean {
  return logCount > 0;
}

/**
 * The empty-state decision for the table body. Its own function (rather than
 * an inline `items.length === 0` ternary) purely so it has a name a test can
 * pin — "no users" must read differently on screen from "the API is
 * unreachable" (the page-level error banner), and this is the boundary that
 * decides which one a caller sees.
 */
export function isEmpty(items: unknown[]): boolean {
  return items.length === 0;
}
