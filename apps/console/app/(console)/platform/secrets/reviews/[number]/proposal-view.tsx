// @tesserix/web's barrel is "use client" — see `access-card.tsx`'s identical
// note. `page.tsx` stays a server component (the fetch has to happen there);
// everything that touches `@tesserix/web`, plus the transitions this route's
// own controls need, lives here instead.
"use client";

import { useState, useTransition } from "react";
import { Button } from "@tesserix/web";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { ChangedFile, ProposalDetail } from "@/lib/secrets";
import { approveAndMergeAction, rejectProposalAction } from "./actions";

/**
 * GitHub's `mergeable_state` values this console has actually observed or can
 * find documented for a pull request. `"clean"` is the only one that means
 * "GitHub says this can merge cleanly right now" — every other value,
 * including ones not in this set, is rendered as-is rather than glossed,
 * because this console has no way to verify what each one means for every
 * possible upstream state and a wrong gloss is worse than the raw string.
 */
const MERGEABLE_CLEAN = "clean";

/**
 * The refusal copy a `platform`-only operator sees instead of any control.
 * Exported so the test asserts the shipped string, matching this console's
 * convention for hand-authored copy (`REVIEWS_EMPTY_MESSAGE`, `../page.tsx`).
 */
export const CANNOT_APPROVE_MESSAGE = "You cannot approve this. Someone holding rotate-credentials can.";

/**
 * Which of the three outcomes this proposal is in, FROM THIS BROWSER TAB'S
 * point of view.
 *
 * This is deliberately not derived from `ProposalDetail` — `gitops.PullDetail`
 * (`lib/secrets.ts`) carries no merged/rejected status field at all; GitHub's
 * pull request resource has a `state`/`merged` pair, but `secrets-api`'s
 * `Pull` never reads or forwards it (`internal/gitops/review.go`), so there
 * is nothing on the wire this component could read that fact from. `"open"`
 * is therefore the only state a fresh render can ever start in; `"merged"`/
 * `"rejected"` are reached only by this component's own successful action —
 * they describe "what I, the operator at this screen, just did", not a
 * persisted fact that would still be there after a reload. A future task
 * that adds the field to `ProposalDetail` could seed this from the initial
 * prop instead; nothing here assumes it never will.
 */
type Outcome = { kind: "open" } | { kind: "merged" } | { kind: "rejected" };

export interface ProposalViewProps {
  number: number;
  proposal: ProposalDetail | null;
  state: SurfaceState;
  /**
   * From `page.tsx`'s render-path gate. Not the security control —
   * secrets-api refuses a `platform`-only caller's approve/merge/reject
   * outright (403) — only whether this page offers a control guaranteed to
   * work. See that file's own comment for why both capabilities are checked
   * there.
   */
  canAct: boolean;
  /** The identity shown in "Approved by <who>" / "Rejected by <who>" — the
   *  current operator's session email (falling back to their subject, then
   *  to "you"), computed once in `page.tsx`. This is the operator sitting at
   *  THIS screen, which is exactly who a "you just did this" sentence should
   *  name; it is not read back from GitHub, which is a further reason
   *  `Outcome` above cannot come from `ProposalDetail`. */
  operatorLabel: string;
}

/**
 * One changed file's diff.
 *
 * Rendered as TEXT inside a `<pre>`, never as markup: `file.patch` is a raw
 * unified diff copied verbatim from a GitHub pull request body — content an
 * external contributor to `tesserix-k8s` (or anyone who can open a PR there)
 * controls, not something this console generated. Interpreting it as HTML
 * would let a diff line inject markup into an operator's browser; passing it
 * through `{file.patch}` as a React child is the one path that can't, no
 * matter what the patch contains.
 *
 * The wrapping `div` scrolls horizontally on its own (`overflow-x-auto`) so
 * a long diff line — or `patch` carrying non-ASCII bytes that render wider
 * than their character count — widens this box, never the page body.
 * `whitespace-pre` on the `<pre>` keeps every line's own width intact
 * instead of letting the browser wrap it, which is what makes the
 * scrollbar the right fix instead of a reflow.
 */
function ChangedFileDiff({ file }: { file: ChangedFile }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-muted-foreground">
        {file.filename}{" "}
        <span className="text-success">+{file.additions}</span>{" "}
        <span className="text-destructive">-{file.deletions}</span>
      </p>
      <div className="overflow-x-auto rounded-md border">
        <pre className="whitespace-pre p-3 font-mono text-xs">{file.patch}</pre>
      </div>
    </div>
  );
}

/**
 * The proposal detail surface: the diff, and the approve/merge/reject
 * controls beneath it. `page.tsx` (the server component) fetches and
 * decides `state`/`canAct`; this component only renders what it is handed
 * and manages the two actions a click here can take.
 */
export function ProposalView({ number, proposal, state, canAct, operatorLabel }: ProposalViewProps) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "open" });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (state.kind !== "ready" || !proposal) {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage="This proposal could not be found."
        reauthReturnTo={`/platform/secrets/reviews/${number}`}
      />
    );
  }

  function handleApproveAndMerge() {
    setError(null);
    startTransition(async () => {
      const result = await approveAndMergeAction(number);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOutcome({ kind: "merged" });
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectProposalAction(number);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOutcome({ kind: "rejected" });
    });
  }

  const isClean = proposal.mergeableState === MERGEABLE_CLEAN;

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title={`#${proposal.number} ${proposal.title}`}
        description={`Opened by ${proposal.author}`}
        breadcrumbs={[
          { label: "Reviews", href: "/platform/secrets/reviews" },
          { label: `#${proposal.number}` },
        ]}
      />

      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted-foreground">
          Branch <code className="font-mono">{proposal.branch}</code>
        </p>
        <p>
          {isClean ? (
            <span>GitHub says this can merge.</span>
          ) : (
            <span>
              GitHub says this cannot merge yet — reported state:{" "}
              <code className="font-mono">{proposal.mergeableState}</code>
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {proposal.approvals.length > 0
            ? `Already approved by ${proposal.approvals.join(", ")}`
            : "No one has approved this yet."}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {proposal.files.map((file) => (
          <ChangedFileDiff key={file.filename} file={file} />
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {outcome.kind === "merged" ? (
        <p>Approved by {operatorLabel}</p>
      ) : outcome.kind === "rejected" ? (
        <p>Rejected by {operatorLabel} — nothing changed</p>
      ) : canAct ? (
        <div className="flex gap-3">
          <Button type="button" onClick={handleApproveAndMerge} disabled={isPending}>
            Approve & merge
          </Button>
          <Button type="button" variant="secondary" onClick={handleReject} disabled={isPending}>
            Reject
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{CANNOT_APPROVE_MESSAGE}</p>
      )}
    </div>
  );
}
