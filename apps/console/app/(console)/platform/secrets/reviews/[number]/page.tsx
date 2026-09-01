import { notFound } from "next/navigation";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { fetchProposal } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { requiresCapability } from "@/lib/internal-access";
import type { ProposalDetail } from "@/lib/secrets";
// Reused rather than re-implemented: the list page (`../page.tsx`) already
// carries the 503 "no review repository configured" special-case (secrets-api
// answers 503, not 501 — see that file's own doc comment on
// `REVIEW_REPOSITORY_NOT_CONFIGURED`), and this route hits the exact same
// upstream. `reviewsState` takes a `proposals` array for the "empty" branch
// `resolveState` needs — passing a one-element array when this route has a
// single proposal is the same shape, not a workaround.
import { reviewsState } from "../page";
import { ProposalView } from "./proposal-view";

/**
 * One proposal's diff plus the approve/merge/reject controls — the detail
 * route a queue row (`proposals-table.tsx`'s `proposalDetailHref`) links to.
 *
 * No route id registers this path in `packages/console-core/src/routes.ts` —
 * see `proposalDetailHref`'s own comment: detail routes are not registered
 * in this console.
 */

/**
 * `params.number` is whatever the URL segment was, unvalidated. A
 * non-numeric or non-positive value can never identify a GitHub pull
 * request, so it is rejected as `notFound()` before `fetchProposal` ever
 * runs — the same fail-closed shape `secrets/[...path]/page.tsx`'s
 * `parseStoreParam` uses for its own unvalidated segment.
 */
function parseProposalNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number: rawNumber } = await params;
  const number = parseProposalNumber(rawNumber);
  if (number === null) {
    notFound();
  }

  let proposal: ProposalDetail | null = null;
  let error: unknown = null;
  try {
    proposal = await fetchProposal(number);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      notFound();
    }
    error = caught;
  }

  const state = reviewsState({ error, proposals: proposal ? [proposal] : [] });

  // THE RENDER PATH, NOT THE CONTROL — same shape as every other render-path
  // gate in this console (`secrets/[...path]/page.tsx`, `tickets/[id]/
  // page.tsx`, `billing/catalog/page.tsx`): the session cookie's snapshot,
  // read synchronously, never the live capability gate (the async one
  // `actions.ts` uses for the actual mutation). Approving,
  // merging, and rejecting all sit behind secrets-api's `live` route group
  // (`platform` + `rotate-credentials` — see `approveProposal`'s doc comment
  // in `lib/secrets-api.ts`), which enforces the real gate itself; this only
  // decides whether the page offers a control guaranteed to work.
  //
  // Both capabilities are checked here, not just `rotate-credentials`, even
  // though `/platform/secrets/reviews` (the queue this route is reached
  // from) already requires `platform` to view: this page can also be reached
  // directly by URL, and checking only the one capability that happens to
  // differ between the two operators in the brief's example would silently
  // stop being correct the day the queue's own requirement changes.
  const session = await getCurrentSession();
  const canAct =
    !requiresCapability() ||
    (hasCapability(session?.roles, "platform") && hasCapability(session?.roles, "rotate-credentials"));

  // The identity shown in "Approved by <who>" / "Rejected by <who>" after an
  // action succeeds THIS session — see `ProposalView`'s doc comment for why
  // that is a client-side fact rather than something re-read from
  // `ProposalDetail`, which has no merged/rejected status field at all.
  const operatorLabel = session?.email ?? session?.sub ?? "you";

  return (
    <ProposalView
      number={number}
      proposal={proposal}
      state={state}
      canAct={canAct}
      operatorLabel={operatorLabel}
    />
  );
}
