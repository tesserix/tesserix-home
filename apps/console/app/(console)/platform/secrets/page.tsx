import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — see `outbox/page.tsx`'s identical note, which is where this
// surface's shape is copied from.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchSecretsInventory } from "@/lib/secrets-api";
import type { SecretsInventory } from "@/lib/secrets";
import { SecretsTable } from "./secrets-table";

/**
 * The secrets inventory — every secret in the estate, flagging the ones no
 * application can read.
 *
 * ONE read, like the estate outbox and the tenant directory: `secrets-api`
 * fans out across the enabled backends and the OpenBao grants, and
 * `fetchSecretsInventory` (`@/lib/secrets-api`) assembles the rows, the
 * counts, and whether the walk that produced them reached every leaf. No
 * apps/web fallback — this surface never existed there; its predecessor is
 * secret-service's own UI, a separate application being retired.
 *
 * # The property this surface exists to hold
 *
 * "No reader" is the alarm this page exists to raise, and two things must
 * never be allowed to blunt it:
 *
 *   - A Google Secret Manager row's `hasReader` is `null` — "not knowable
 *     here", because GSM's readers are IAM bindings this console cannot see —
 *     and must never render or filter as an orphan. `secrets-table.tsx`
 *     compares against `hasReader === false` explicitly for exactly this
 *     reason; see its own comments.
 *   - `SecretsInventory.complete` is `false` when the estate walk was cut
 *     short. On a surface whose job is spotting a MISSING reader, "not in the
 *     list" is itself the signal an operator must act on — a truncated list
 *     presented as the whole estate turns an omission into a false all-clear.
 *     `secrets-table.tsx` renders a notice whenever `complete` is `false`.
 *
 * A 501 from `secretsRequest` (`SECRETS_API_ORIGIN` unset) is this
 * deployment's current state until the chart cutover that redeploys
 * `secrets-api` lands, and reads the same as a parked observability plane:
 * calm, not broken, nothing to retry.
 */

/** Copy for the plain `empty` state — no secrets in any enabled store.
 *  Exported so the test asserts the shipped string. */
export const SECRETS_EMPTY_MESSAGE = "No secrets found in any configured store.";

/**
 * Copy for the 501, which is NOT an error and must not read as one.
 *
 * A 501 here means `SECRETS_API_ORIGIN` is not set for this deployment —
 * secrets-api has not been cut over to yet, which is production's state
 * today. Neither cause is a fault, and the kit's default 501 copy points at
 * `docs/observability-park.md`, which is right for a parked metrics plane and
 * wrong here — the remedy is a chart cutover, not anything an operator can
 * read about observability.
 */
export const SECRETS_UNAVAILABLE_TITLE = "The secrets inventory is not configured";
export const SECRETS_UNAVAILABLE_MESSAGE =
  "This deployment has no SECRETS_API_ORIGIN set, so the console cannot read the estate's " +
  "secret stores yet. Nothing is broken and there is nothing to retry — this surface turns on " +
  "once secrets-api is deployed and configured.";

/**
 * Narrow the read's rejection, attaching this surface's own 501 copy.
 *
 * Mirrors `outbox/page.tsx`'s `outboxReadError`: the status is what carries
 * the meaning, but the kit's default copy for a 501 is about a parked
 * observability plane, which is not what a 501 means here. The override is
 * opt-in precisely so `message` (an internal string: "backends:
 * SECRETS_API_ORIGIN is not set") never reaches the page.
 */
export function secretsReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: SECRETS_UNAVAILABLE_TITLE, message: SECRETS_UNAVAILABLE_MESSAGE },
  };
}

export interface SecretsStateInput {
  /** Whatever `fetchSecretsInventory` rejected with, or null. */
  readonly error: unknown;
  readonly rows: readonly unknown[];
}

/**
 * Which state the inventory is in.
 *
 * `filtered` is always false: the store/reader filter is client-side over the
 * whole fetched inventory (`secrets-table.tsx`), never a second server round
 * trip, so there is no server-side notion of "filtered empty" for this
 * surface to report.
 */
export function secretsState(input: SecretsStateInput): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error: secretsReadError(input.error),
    rows: input.rows,
    filtered: false,
  });
}

const EMPTY_INVENTORY: SecretsInventory = {
  rows: [],
  counts: { all: 0, openbao: 0, gcpsm: 0, noReader: 0 },
  complete: true,
};

export default async function SecretsInventoryPage() {
  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would render the route
  // error boundary instead — replacing "the inventory is not configured yet"
  // with a stack trace's worth of nothing.
  let inventory: SecretsInventory = EMPTY_INVENTORY;
  let error: unknown = null;
  try {
    inventory = await fetchSecretsInventory();
  } catch (caught: unknown) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Secrets"
        description="Every secret in the estate, and which of them no application can read."
      />

      <SecretsTable
        inventory={inventory}
        state={secretsState({ error, rows: inventory.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />
    </div>
  );
}
