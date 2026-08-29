import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — it 500'd the dashboard once.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { readOutbox, type EstateOutbox, type OutboxSourceFailure } from "@/lib/outbox";
import { OutboxTable } from "./outbox-table";

/**
 * The estate outbox — every federating product's `outbox_events` rows, in one
 * ledger.
 *
 * ONE read, like the tenant directory and the inbox: `GET /v1/outbox` fans out
 * behind the platform API and returns a partial result plus a per-source
 * `failures` list, and a `notImplemented` list of products that declared the
 * endpoint but currently have nothing to report. `readOutbox` (`@/lib/outbox`)
 * has no apps/web fallback — this surface never existed there.
 *
 * # The property this surface exists to hold
 *
 * A governance surface must never let "nothing is federated" read as "nothing
 * is here". Three response shapes are possible and this page renders each one
 * distinctly:
 *
 *   - **501, no `events` key.** Nothing is federated at all —
 *     `FEDERATION_MARK8LY_ENDPOINTS` (or any product's) names no outbox
 *     implementer, which is production's state today. `readOutbox` rejects
 *     with a `PlatformApiError` carrying `status: 501`, `outboxReadError`
 *     attaches this surface's own copy, and `resolveState` maps it to
 *     `instrumentation-unavailable` — a calm callout, never an empty table.
 *   - **200, `events: []`, `notImplemented: []`.** Federated, and genuinely
 *     clean. `outboxState` resolves to `empty`, and `emptyMessageFor` says so
 *     plainly.
 *   - **200, `events: []`, `notImplemented` populated.** Federated, but every
 *     configured product answered 501 for this particular request. Also
 *     resolves to `empty` — there is genuinely nothing to tabulate — but
 *     `emptyMessageFor` refuses to say the outbox is clean, and
 *     `NotImplementedNotice` (in `./outbox-table`) renders a banner naming
 *     which products answered that way, so this state cannot be mistaken for
 *     the one above it by row count alone.
 */

/** Copy for the plain `empty` state — no rows, and nothing missing or
 *  declining to report. Exported so the test asserts the shipped string. */
export const OUTBOX_EMPTY_MESSAGE =
  "No outbox events. Every federated product reports a clean outbox.";

/**
 * The `empty` copy when rows are zero AND something is missing from the
 * picture — either a product could not be read, or a product answered "no
 * events for this request".
 *
 * `empty` is still the right `SurfaceState` — there is genuinely nothing to
 * tabulate — but the default copy would assert a clean estate this surface
 * cannot back. "No events" and "no events that we could confirm" are
 * different claims, and only the second is true here. `NotImplementedNotice`
 * and `IncompleteOutbox` (in `./outbox-table`) are what make the reason
 * visible; this sentence is what stops the empty state's own text from
 * contradicting them.
 */
export function emptyMessageFor(input: {
  failures: readonly OutboxSourceFailure[];
  notImplemented: readonly string[];
}): string {
  const { failures, notImplemented } = input;
  if (failures.length === 0 && notImplemented.length === 0) return OUTBOX_EMPTY_MESSAGE;

  const reasons: string[] = [];
  if (failures.length > 0) {
    reasons.push(
      failures.length === 1
        ? "one product could not be read at all"
        : `${failures.length} products could not be read at all`,
    );
  }
  if (notImplemented.length > 0) {
    reasons.push(
      notImplemented.length === 1
        ? "one product reported no events for this request"
        : `${notImplemented.length} products reported no events for this request`,
    );
  }

  return `No outbox events were confirmed — ${reasons.join(" and ")} — so this is not evidence the estate's outbox is clean.`;
}

/**
 * Copy for the 501, which is NOT an error and must not read as one.
 *
 * A 501 here means no product federates the outbox endpoint at all — the
 * platform API's `SlugsImplementing("outbox")` is empty, which is exactly
 * production's state until a later task sets
 * `FEDERATION_MARK8LY_ENDPOINTS`. Neither cause is a fault, and the kit's
 * default 501 copy points at `docs/observability-park.md`, which is right for
 * a parked metrics plane and wrong here — the remedy is a federation config
 * value, not anything an operator can read about observability.
 */
export const OUTBOX_UNAVAILABLE_TITLE = "The outbox is not federated yet";
export const OUTBOX_UNAVAILABLE_MESSAGE =
  "No product is federating outbox events to the console yet. Nothing is broken and there is " +
  "nothing to retry — this surface turns on when at least one product declares the outbox " +
  "endpoint.";

/**
 * Narrow the read's rejection, attaching this surface's own 501 copy.
 *
 * The status is what carries the meaning — `resolveState` maps 501 to
 * `instrumentation-unavailable` and everything else to `error` — but the
 * default copy for that state is about a parked observability plane, which is
 * not what a 501 means here. The override is opt-in precisely so `message`
 * (an internal string: "outbox: PLATFORM_API_ORIGIN is not set…") never
 * reaches the page.
 */
export function outboxReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: OUTBOX_UNAVAILABLE_TITLE, message: OUTBOX_UNAVAILABLE_MESSAGE },
  };
}

export interface OutboxStateInput {
  /** Whatever `readOutbox` rejected with, or null. */
  readonly error: unknown;
  readonly rows: readonly unknown[];
}

/**
 * Which state the ledger is in.
 *
 * The same rule every sibling federated surface states: **any rows at all
 * means the rows render.** A partial answer is a 200 carrying `failures` (and
 * possibly `notImplemented`), so it arrives with `error: null` and resolves to
 * `ready` — the gaps are reported beside the table by
 * `IncompleteOutbox`/`NotImplementedNotice`, never instead of it. Only a whole
 * read that threw replaces the table, because then there is no table to show.
 *
 * `filtered` is always false: this surface offers no filters yet.
 */
export function outboxState(input: OutboxStateInput): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error: outboxReadError(input.error),
    rows: input.rows,
    filtered: false,
  });
}

const EMPTY_OUTBOX: EstateOutbox = { events: [], failures: [], notImplemented: [] };

export default async function EstateOutboxPage() {
  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would render the route
  // error boundary instead — replacing "the outbox is not federated yet" with
  // a stack trace's worth of nothing.
  let outbox: EstateOutbox = EMPTY_OUTBOX;
  let error: unknown = null;
  try {
    outbox = await readOutbox();
  } catch (caught: unknown) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Outbox"
        description="Every federating product's outbox events, in one ledger."
      />

      <OutboxTable
        outbox={outbox}
        state={outboxState({ error, rows: outbox.events })}
        emptyMessage={emptyMessageFor(outbox)}
        reauthReturnTo="/platform/outbox"
      />
    </div>
  );
}
