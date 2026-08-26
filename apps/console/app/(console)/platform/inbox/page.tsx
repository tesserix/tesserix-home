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
import { fetchEstateInbox } from "@/lib/platform-api";
import type { EstateInbox, InboxSourceFailure } from "@/lib/inbox";
import { InboxQueue } from "./inbox-queue";

/**
 * The estate inbox — everything waiting on a human, across every product that
 * implements contract §3.2, in one queue.
 *
 * §3.2 calls this "the load-bearing one". §8.5 says why it lives here rather
 * than on any product's rail: implementing an inbox does not earn a product a
 * rail entry, it makes that product a source in a surface that already exists.
 * That is the same call #139 made for Kora's audit trail, and the reason
 * `kora.feedback` is `retired` in console-core's routes.ts rather than
 * `pending`.
 *
 * ONE read: `GET /v1/inbox` fans out behind the platform API and returns a
 * partial result plus a per-source `failures` list.
 *
 * The property this surface exists to hold: **a short queue must be true.** An
 * operator reading one concludes the work is nearly done. A product silently
 * dropping out of the fan-out turns that into a false all-clear — which is why
 * `failures` is rendered above the queue rather than logged, and why the total
 * says plainly that it counts only products that answered.
 */

/**
 * The empty state, which carries more weight here than on any other surface.
 *
 * This queue is genuinely empty today: Kora's two source tables are at zero
 * rows (verified in kora#474 against the live database) and mark8ly does not
 * implement §3.2 at all. So the FIRST thing anyone sees on this page is this
 * sentence, and it has to say the right thing.
 *
 * "Nothing is waiting" is a real, good and reassuring answer. It must not read
 * as "nothing is connected" — an operator who suspects the latter goes looking
 * for a fault that does not exist, and one who should suspect it and does not
 * is worse off still. Hence the second clause: the queue names what it covers,
 * so the reassurance is bounded by something checkable.
 */
export const INBOX_EMPTY_MESSAGE =
  "Nothing is waiting. Every product that answered has an empty queue.";

/**
 * The `empty` copy when the queue is empty AND a source was lost.
 *
 * Still the `empty` state — there is genuinely nothing to tabulate — but the
 * default copy would assert an all-clear this surface cannot back. "Nothing is
 * waiting" and "nothing is waiting that we could read" are different claims,
 * and only the second is true here.
 */
export function emptyMessageFor(failures: readonly InboxSourceFailure[]): string {
  if (failures.length === 0) return INBOX_EMPTY_MESSAGE;
  return (
    "Nothing was read — and " +
    (failures.length === 1
      ? "one product could not be reached at all"
      : `${failures.length} products could not be reached at all`) +
    ", so this is not evidence that nothing is waiting."
  );
}

/**
 * The honest limit of what is on screen.
 *
 * Each product is asked for a bounded page, so a product with a deep queue is
 * shown in part. No number is quoted: the bound is `platform-api.ts`'s to
 * choose, and a transcribed constant here is the copy that goes stale.
 */
export const INBOX_SCOPE_NOTE =
  "Each product is asked for a bounded page, so a deep queue may not be listed in full. " +
  "Kind and severity are each product's own words, shown unchanged.";

/**
 * Copy for the 501, which is NOT an error and must not read as one.
 *
 * A 501 here means no product declares §3.2 — `FEDERATION_<SLUG>_ENDPOINTS`
 * names no product, or `PLATFORM_API_ORIGIN` is unset. Neither is a fault, and
 * both are config rather than an outage.
 *
 * This distinction is the whole reason the platform API answers 501 instead of
 * an empty 200: an unconfigured deployment must not be able to produce the
 * reassurance of an empty queue. The kit's default 501 copy points at
 * `docs/observability-park.md`, which is right for a parked metrics plane and
 * wrong here — it would send an operator to read about instrumentation when
 * the answer is a config value.
 */
export const INBOX_UNAVAILABLE_TITLE = "The estate inbox is not switched on";
export const INBOX_UNAVAILABLE_MESSAGE =
  "No product is federating a queue to the console yet. Nothing is broken and " +
  "there is nothing to retry — this surface turns on when at least one product " +
  "declares the inbox endpoint.";

/**
 * Narrow the read's rejection, attaching this surface's own 501 copy.
 *
 * The status carries the meaning — `resolveState` maps 501 to
 * `instrumentation-unavailable` and everything else to `error`. The override is
 * opt-in precisely so `message` (an internal string) never reaches the page.
 */
export function inboxReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: INBOX_UNAVAILABLE_TITLE, message: INBOX_UNAVAILABLE_MESSAGE },
  };
}

export interface QueueStateInput {
  readonly error: unknown;
  readonly items: readonly unknown[];
}

/**
 * Which state the queue is in.
 *
 * **Any items at all means the items render.** A partial answer is a 200
 * carrying `failures`, so it arrives with `error: null` and resolves to
 * `ready` — the lost products are reported beside the queue, never instead of
 * it. Only a whole read that threw replaces the table, because then there is
 * no table to show.
 *
 * `filtered` is false: this surface offers no filters yet, and claiming
 * otherwise would render the kit's "no results — clear filters" copy for a
 * queue that is simply empty. That would turn a good answer into an apparent
 * mistake by the operator.
 */
export function queueState(input: QueueStateInput): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense covers the wait, not this state.
    isLoading: false,
    error: inboxReadError(input.error),
    rows: input.items,
    filtered: false,
  });
}

const EMPTY_INBOX: EstateInbox = { items: [], total: 0, failures: [] };

export default async function EstateInboxPage() {
  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would render the route
  // error boundary instead — replacing "the inbox is not switched on" with a
  // stack trace's worth of nothing.
  let inbox: EstateInbox = EMPTY_INBOX;
  let error: unknown = null;
  try {
    inbox = await fetchEstateInbox();
  } catch (caught: unknown) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Inbox"
        description="Everything waiting on a human, across every product."
      />

      <InboxQueue
        inbox={inbox}
        state={queueState({ error, items: inbox.items })}
        emptyMessage={emptyMessageFor(inbox.failures)}
        scopeNote={INBOX_SCOPE_NOTE}
        reauthReturnTo="/platform/inbox"
      />
    </div>
  );
}
