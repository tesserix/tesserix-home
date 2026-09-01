import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — see `secrets/page.tsx`'s identical note, which is where
// this surface's shape is copied from.
import {
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchProposals } from "@/lib/secrets-api";
import type { Proposal } from "@/lib/secrets";
import { ProposalsTable } from "./proposals-table";

/**
 * The secrets-access review queue — every open pull request against
 * `tesserix-k8s` that the console itself raised to add or remove a reader.
 *
 * ONE read, like the sibling secrets inventory: `GET /api/reviews`
 * (`fetchProposals` in `@/lib/secrets-api`) returns the open proposal list. No
 * apps/web fallback — this surface never existed there, matching
 * `platform.secretsReviews`'s route-id comment in
 * `packages/console-core/src/routes.ts`.
 *
 * # Why this page asks for nothing beyond `platform`
 *
 * Reading the queue and acting on an entry are different acts, and this page
 * only does the first. `secrets-api.ts` groups its endpoints accordingly:
 * `GET /api/reviews` is in the `read` group (`platform` alone), while
 * approve/merge/reject are in `live` (`platform` + `rotate-credentials`) —
 * see the doc comments on `fetchProposals` and `approveProposal`. If this
 * page required the verb just to LOOK, every operator able to see a proposal
 * would also be able to merge it, and the two-tier review design would
 * collapse to one tier even though the routing table still claimed two. So
 * `ProposalsTable` renders no approve/merge/reject affordance at all — that
 * authority belongs entirely to the detail route a later task builds.
 */

/** Copy for the empty queue — nothing open. Exported so the test asserts the
 *  shipped string. */
export const REVIEWS_EMPTY_MESSAGE = "Nothing is waiting for approval.";

/**
 * `secrets-api`'s reviews endpoints answer 503, not 501, when no review
 * repository is configured (`handlers/reviews.go`'s `configured()`) — see
 * `fetchProposals`'s doc comment in `lib/secrets-api.ts`. Named locally
 * rather than imported from `surface-state`, which only names `NOT_IMPLEMENTED`
 * (501): the two surfaces this console has parked so far (`secrets/page.tsx`'s
 * `SECRETS_API_ORIGIN` gap, `inbox/page.tsx`'s no-federated-product gap) both
 * happen to answer 501, but this one's Go handler was written against 503, and
 * inventing a shared constant for a sample size of two would claim a pattern
 * that may not hold.
 */
const REVIEW_REPOSITORY_NOT_CONFIGURED = 503;

/**
 * Copy for the 503, which is NOT an error and must not read as one.
 *
 * A 503 here means `secrets-api` has no review repository configured for
 * this deployment — the GitOps side of the chart cutover has not landed yet,
 * which is production's state today. Nothing is broken and there is nothing
 * to retry; the remedy is configuration, not an outage response.
 */
export const REVIEWS_UNAVAILABLE_TITLE = "The review queue is not configured";
export const REVIEWS_UNAVAILABLE_MESSAGE =
  "This deployment has no review repository configured, so secrets-api cannot list open " +
  "proposals yet. Nothing is broken and there is nothing to retry — this surface turns on " +
  "once a review repository is set.";

/**
 * Narrow the read's rejection, attaching this surface's own 503 copy.
 *
 * Mirrors `secretsReadError` (`secrets/page.tsx`) and `inboxReadError`
 * (`inbox/page.tsx`), but keyed on 503 rather than 501 — see
 * `REVIEW_REPOSITORY_NOT_CONFIGURED`'s doc comment for why. `message` (an
 * internal string built from the caught error) is deliberately never let
 * through to `unavailable.message`.
 */
export function reviewsReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== REVIEW_REPOSITORY_NOT_CONFIGURED) return error;
  return {
    ...error,
    unavailable: { title: REVIEWS_UNAVAILABLE_TITLE, message: REVIEWS_UNAVAILABLE_MESSAGE },
  };
}

export interface ReviewsStateInput {
  /** Whatever `fetchProposals` rejected with, or null. */
  readonly error: unknown;
  readonly proposals: readonly unknown[];
}

/**
 * Which state the queue is in.
 *
 * `resolveState` itself only special-cases `NOT_IMPLEMENTED` (501) for the
 * `instrumentation-unavailable` kind, so a bare 503 would fall through to its
 * generic `error` branch. This function is what turns THIS surface's 503
 * into the same kind, with this surface's own copy — it is not achieved by
 * widening `resolveState`'s 501 check, which stays untouched and keeps
 * mapping 501 to its own default copy for every other caller.
 *
 * `filtered` is always false: this queue has no filters yet.
 */
export function reviewsState(input: ReviewsStateInput): SurfaceState {
  const error = reviewsReadError(input.error);
  // `reauthRequired` is checked before the 503 special-case, matching
  // `resolveState`'s own ordering: a session with no usable operator token
  // has a remedy ("sign in again") that applies no matter what status the
  // rejection also happened to carry, and it must win over "not configured".
  if (error?.reauthRequired) {
    return resolveState({ isLoading: false, error, rows: input.proposals, filtered: false });
  }
  if (error && error.status === REVIEW_REPOSITORY_NOT_CONFIGURED) {
    return {
      kind: "instrumentation-unavailable",
      title: error.unavailable?.title,
      message: error.unavailable?.message,
    };
  }
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error,
    rows: input.proposals,
    filtered: false,
  });
}

export default async function SecretsReviewsPage() {
  // Caught rather than allowed to reject: a 503 and a genuine failure are
  // both states this page renders, and an uncaught rejection would render
  // the route error boundary instead — replacing "the review queue is not
  // configured" with a stack trace's worth of nothing.
  let proposals: Proposal[] = [];
  let error: unknown = null;
  try {
    proposals = await fetchProposals();
  } catch (caught: unknown) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Reviews"
        description="Proposals waiting on someone who can approve them. Approving merges the change; ArgoCD syncs it from there."
      />

      <ProposalsTable
        proposals={proposals}
        state={reviewsState({ error, proposals })}
        emptyMessage={REVIEWS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets/reviews"
      />
    </div>
  );
}
