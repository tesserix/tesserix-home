import { ESTATE } from "@tesserix/console-core";
// Imported from `surface-state` and not from `states`: this module is
// rendered on the server, and `states.tsx` is a "use client" module whose
// exports become client references that throw when called there. Same reason
// `page.tsx` imports it from here.
import { resolveState } from "@/components/kit/surface-state";
import { dbReadError } from "@/lib/db-read-error";
import { wonWithoutConversion, type HandoffRow } from "@/lib/db/crm-repo";
import { fetchConversionSignal, type ConversionSignal } from "@/lib/crm-conversion";
import { HandoffView, type HandoffItem } from "./handoff-view";

/**
 * The Handoff tab: won opportunities awaiting a conversion link.
 *
 * Its own module rather than a section of `page.tsx`, which carries the
 * filters, the tab machinery and the Work tab and had reached the size where
 * appending a third tab to it was the wrong move. Nothing here is shared with
 * the other tabs — the fan-out, its two bounds and the row read are used by
 * this tab and only this tab.
 */

const HANDOFF_LIMIT = 100;

/** Bounds simultaneous outbound `fetchConversionSignal` calls. A handoff
 *  queue at `HANDOFF_LIMIT` is up to 100 requests fanned out at once (Task
 *  9's review, carried forward) — correct for "one hung product must not
 *  stall the others", but 100 *simultaneous* connections through the one
 *  apps/web proxy every product's conversion-status check goes through is
 *  its own kind of thundering herd.
 *
 *  Ruling 32: a concurrency cap ALONE does not bound total latency — it
 *  multiplies it. At 10 workers and up to `HANDOFF_LIMIT` (100) rows, a
 *  queue where every call times out runs ~10 sequential waves of ~10
 *  requests each: 100 / 10 × 8s (`fetchConversionSignal`'s own timeout) =
 *  80s worst case — TEN TIMES the 8s a single unbounded fan-out would have
 *  taken, and past most hosting request budgets outright. The cap bounds
 *  concurrent CONNECTIONS; `HANDOFF_FETCH_DEADLINE_MS` below is what
 *  actually bounds render TIME. */
const HANDOFF_FETCH_CONCURRENCY = 10;

/**
 * Total wall-clock budget for the whole handoff fan-out, independent of how
 * many rows there are or how the concurrency cap paces them (Ruling 32).
 * Once this elapses, every row still in flight is rendered as `unknown` and
 * the page proceeds with whatever answered in time — never a fabricated
 * `none`. That costs nothing in correctness: `unknown` is already the
 * honest state for "we could not get a trustworthy answer in time"
 * (`crm-conversion.ts`'s own contract for a timeout or an unreachable
 * product), and it already renders distinctly from `none`
 * (`handoff-view.tsx`). The underlying `fetchConversionSignal` calls are
 * not cancelled when the deadline passes — they keep running until they
 * resolve or hit their own 8s timeout — this just stops the RENDER from
 * waiting on them.
 */
const HANDOFF_FETCH_DEADLINE_MS = 10_000;

/** The `empty` copy for this tab, exported so tests assert on the string the
 *  page ships rather than a second copy of it that could drift. */
export const HANDOFF_EMPTY_MESSAGE =
  "Nothing to hand off. Every won deal is already linked to a conversion.";

/**
 * One row's signal, never throwing: a missing contact email skips the
 * network call entirely (nothing to ask, honestly `unknown`, not a wasted
 * request and not `none`), and a `fetchConversionSignal` rejection — its own
 * contract says this shouldn't happen, this is belt-and-braces against a
 * caller-side bug — is caught here rather than left to reject the worker
 * that's awaiting it.
 */
async function fetchRowSignal(row: HandoffRow): Promise<ConversionSignal> {
  // A migrated deal has no product (0020/0021 grandfather those rows), so
  // there is no product admin API to address the question to — the same
  // "nothing to ask" case as a missing email, and the same honest
  // `unknown`. Skipping the call is also what keeps the URL well-formed:
  // asking `/api/admin/apps/null/conversion-status` would be a fabricated
  // question whose 404 answer means nothing.
  if (!row.product || !row.primaryEmail) {
    return { product: row.product, state: "unknown" };
  }
  try {
    return await fetchConversionSignal(row.product, row.primaryEmail);
  } catch {
    return { product: row.product, state: "unknown" };
  }
}

/**
 * The handoff tab's fan-out: one `fetchConversionSignal` call per row,
 * bounded two ways at once (Ruling 32) — `HANDOFF_FETCH_CONCURRENCY` caps
 * how many are ever in flight together, and `HANDOFF_FETCH_DEADLINE_MS`
 * caps how long the render waits for the whole batch, so the cap alone can
 * never turn into the N-waves latency the constant's comment above works
 * through.
 *
 * A worker pool, not a batch-of-N-then-wait chunking scheme: batching would
 * let one slow request in a batch hold up every other slot in that same
 * batch even though `concurrency - 1` other workers sit idle; a pool
 * immediately hands a finished worker the next row, so throughput is
 * bounded by `concurrency`, not by the slowest row in an arbitrary chunk.
 * Each worker writes straight into `results` as it finishes, so whichever
 * side of the `Promise.race` below wins, every row that DID finish in time
 * is still there to read — only rows a worker never reached before the
 * deadline are missing, and those fall through to `unknown` in the final
 * map. The still-running calls behind them are not cancelled; nothing here
 * waits on them past the deadline either way.
 *
 * `deadlineMs` is a parameter (not only the module constant) so a test can
 * exercise the deadline path without a real ~10s wait.
 */
export async function buildHandoffItems(
  rows: readonly HandoffRow[],
  options: { deadlineMs?: number } = {},
): Promise<HandoffItem[]> {
  const deadlineMs = options.deadlineMs ?? HANDOFF_FETCH_DEADLINE_MS;
  const results: (ConversionSignal | undefined)[] = new Array(rows.length);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < rows.length) {
      const index = cursor++;
      results[index] = await fetchRowSignal(rows[index]);
    }
  }
  const workerCount = Math.min(HANDOFF_FETCH_CONCURRENCY, rows.length);
  const poolSettled = Promise.all(Array.from({ length: workerCount }, () => worker()));

  await Promise.race([poolSettled, new Promise<void>((resolve) => setTimeout(resolve, deadlineMs))]);

  return rows.map((row, index) => ({
    opportunityId: row.opportunityId,
    organisationId: row.organisationId,
    organisationName: row.organisationName,
    product: row.product,
    closedAt: row.closedAt,
    // A row no worker reached before the deadline elapsed has no entry yet
    // — `unknown`, the same honest answer as a timed-out or unreachable
    // product, never a fabricated `none`.
    signal: results[index] ?? { product: row.product, state: "unknown" },
  }));
}

/**
 * The Handoff tab's content. A plain awaited function, not a nested async
 * component — see `renderWorkTab` in `page.tsx` for the testability reason —
 * and only ever CALLED (so only ever reads `wonWithoutConversion`/fans out
 * `fetchConversionSignal`) while this tab is the active one; see `tabHref`'s
 * doc comment for why the Work tab must never pay for this.
 */
export async function renderHandoffTab(reauthReturnTo: string) {
  let handoffRows: readonly HandoffRow[] = [];
  let handoffHasMore = false;
  let handoffRowsError: unknown = null;
  try {
    ({ rows: handoffRows, hasMore: handoffHasMore } =
      await wonWithoutConversion(HANDOFF_LIMIT));
  } catch (caught) {
    handoffRowsError = caught;
  }

  // Only fanned out once the row read itself succeeded — a failed
  // `wonWithoutConversion` has no rows to fan a signal fetch out over, and
  // fanning out zero rows is a no-op either way.
  const handoffItems = handoffRowsError ? [] : await buildHandoffItems(handoffRows);

  const handoffState = resolveState({
    isLoading: false,
    error: dbReadError(handoffRowsError, "the handoff queue"),
    rows: handoffItems,
    filtered: false,
  });

  const products = ESTATE.map((product) => ({ context: product.context, name: product.name }));

  return (
    <HandoffView
      items={handoffItems}
      state={handoffState}
      emptyMessage={HANDOFF_EMPTY_MESSAGE}
      hasMore={handoffHasMore}
      products={products}
      reauthReturnTo={reauthReturnTo}
    />
  );
}
