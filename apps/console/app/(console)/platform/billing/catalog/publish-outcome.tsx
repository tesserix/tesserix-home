// Load-bearing, same reason `publish-view.tsx` carries one: this is a
// self-contained display surface with no server-side data fetching of its
// own — the caller (a future page.tsx) reads the attempt and passes it in as
// props. Nothing here holds interactive state, but `Button asChild` /
// `next/link`'s `Link` still require a client boundary the same way
// `organisations-view.tsx`'s does.
"use client";

import { Button, Callout, CalloutDescription, CalloutTitle } from "@tesserix/web";
import Link from "next/link";
import { ConsoleDataTable } from "@/components/kit/console-data-table";
// Type-only across the server/client boundary, deliberately — and NOT
// optional politeness, per `publish-view.tsx`'s identical note: `Orphan`
// reaches `orphans.ts`, which is `server-only` and pulls in `pg` and
// `stripe` through its default dependencies; `PublishAttemptOutcome` reaches
// `publish-repo.ts`, which is `server-only` and pulls in `pg` through
// `tesserixTx`. A VALUE import of either shape here would drag that graph
// into the browser bundle — `tsc` and `vitest` both pass, only `next build`
// catches it.
import type { PublishAttemptOutcome } from "@/lib/db/publish-repo";
import type { Orphan } from "@/lib/billing/orphans";
import type { StripeMode } from "@/lib/billing/stripe-read";

/**
 * The publish OUTCOME screen: what an operator sees once a publish attempt
 * closes, whichever way it closed. `publish-view.tsx` is the "about to
 * happen" surface; this is the "what just happened" one, and Task 5's brief
 * is explicit about why it exists at all — a publish that errors with a
 * spinner and no detail leaves the operator guessing whether Stripe is
 * half-changed. This surface answers that within seconds, not "eventually,
 * from a log an operator has to know to go read".
 *
 * # Operations, not a spinner — and not "check the log later"
 *
 * Every row this renders is a `plan_catalog_publish_operations` row (0038):
 * written write-ahead, before the matching Stripe call, and completed
 * `succeeded` or `failed` once Stripe answers. On a `"failed"` attempt some
 * of these rows are `succeeded` — the executor continues past a single
 * failure — so the table is the only place an operator can see, per
 * operation, what actually landed versus what did not. That is the whole
 * point of this component; a summary count would hide exactly the fact that
 * matters.
 *
 * # Orphans — the ONE failure the nightly parity check cannot see
 *
 * `findOrphans` (`orphans.ts`) is run automatically here (by the caller, on
 * a failed attempt) rather than waiting for the nightly run, because the
 * nightly parity check STRUCTURALLY cannot see this failure mode:
 * `compareCatalogToStripe` only ever looks at Prices carrying a
 * `lookup_key`, and a `replace_price` whose `archive` call never landed
 * leaves the OLD Price `active: true` with NO lookup key (0038's header
 * names this exact failure). The comparator has nothing to join it against
 * and reports `clean` — correctly, by its own rules, and wrongly by every
 * rule that matters to the bill. This surface is the only place that
 * failure becomes visible, so the copy below says so plainly rather than
 * softening it into a generic warning.
 *
 * # Re-plan, never retry
 *
 * There is no "Retry" control anywhere in this component, on purpose.
 * `executePublish` re-observes Stripe and aborts if the plan's fingerprint
 * moved since it was built — a `replace_price` operation captures a Stripe
 * Price id at plan time, and retrying a STALE plan risks acting on an id
 * that is no longer what the plan thinks it is (the same id could have been
 * archived, or a further drift-correction could have superseded it). The
 * only correct recovery is to go back, re-observe what Stripe holds NOW, and
 * build a fresh plan against it — which is exactly what re-planning is.
 * Offering a retry button here would be offering a way to route around the
 * executor's own abort-on-drift protection.
 *
 * # NOT promoted, and said in the operator's terms
 *
 * `publishAction` (`actions.ts`) promotes a revision — writes the
 * `plan_catalog_publications` row 0036's clean-parity check requires — ONLY
 * on a fully `"succeeded"` outcome. A `"failed"` attempt is deliberately NOT
 * promoted: promoting a partly-applied publish would write a false claim
 * into that table, one a later `clean` parity run would then CITE as
 * evidence the wrong revision is live. This component's copy for a failed
 * outcome says the previous revision is still published — that is the
 * literal, current truth of `plan_catalog_publications`, and it is the
 * difference between an operator believing their change is live and knowing
 * it is not.
 *
 * # Consistency with `publish-view.tsx`
 *
 * The `"succeeded"` / `"aborted"` copy below is worded to match
 * `publish-view.tsx`'s `outcomeMessage` (T4's copy, corrected 2026-08-28)
 * rather than say the same thing a different way — a surface a reader might
 * see both of, in either order, should never read like two accounts of one
 * event. The `"failed"` copy extends that same account with what THIS
 * surface adds beyond a status line: the operation table and the orphan
 * check.
 */

export interface PublishOutcomeOperation {
  readonly sequence: number;
  // A plain `string`, not `OperationKind`: a caller passes what the log
  // recorded, and this table's whole job is to show it back verbatim rather
  // than validate it against the plan's own vocabulary.
  readonly kind: string;
  readonly lookupKey: string | null;
  readonly status: "pending" | "succeeded" | "failed";
  readonly error: string | null;
}

/**
 * What `findOrphans` reports, trimmed to what this surface shows. `source`
 * is optional here (real `Orphan` rows always carry one) because the fact
 * that matters to an operator reading this list is the price id and lookup
 * key — the source is provenance a caller may not always have to hand.
 */
export interface PublishOutcomeOrphan {
  readonly priceId: string;
  readonly lookupKey: string | null;
  readonly source?: string;
}

export interface PublishOutcomeProps {
  readonly attemptId: string;
  readonly mode: StripeMode;
  readonly outcome: PublishAttemptOutcome;
  /** Whether `publishAction` promoted the revision — always `false` for a
   *  `"failed"` or `"aborted"` outcome; see this module's header. */
  readonly promoted: boolean;
  /** Every operation the attempt's write-ahead log recorded, in `sequence`
   *  order — empty for `"aborted"`, since `executePublish` never entered
   *  `plan.operations` in that case. */
  readonly operations: readonly PublishOutcomeOperation[];
  /** Orphans found by the automatic post-failure check. Empty on anything
   *  other than a failed attempt with an incomplete `replace_price`. */
  readonly orphans: readonly PublishOutcomeOrphan[];
  /** Where "Re-plan" sends the operator — the catalog surface, so it is a
   *  prop rather than a hardcoded path. */
  readonly replanHref: string;
}

/**
 * The status line. Three outcomes, three different truths — the same
 * discipline `publish-view.tsx`'s `outcomeMessage` documents, and the
 * `"succeeded"` / `"aborted"` sentences below are worded to match it rather
 * than restate the same fact differently.
 */
function outcomeSummary(
  outcome: PublishAttemptOutcome,
  operations: readonly PublishOutcomeOperation[],
): string {
  if (outcome === "succeeded") {
    return "Published. Stripe now matches this revision, and it is the mode's published catalog.";
  }
  if (outcome === "aborted") {
    return (
      "Nothing was written to Stripe. The publish stopped before its first call — the plan moved since it was " +
      "built, or a guard refused on the re-check. Review the changes again to plan against what Stripe holds now."
    );
  }
  const failed = operations.filter((operation) => operation.status === "failed");
  const names = failed.map((operation) => `${operation.kind} ${operation.lookupKey ?? ""}`.trim());
  return (
    `${failed.length} operation(s) failed${names.length > 0 ? `: ${names.join(", ")}` : ""}. ` +
    "Others in this plan may already have been written to Stripe. This attempt was NOT promoted — the previous " +
    "revision is still published. Review the operations below, then re-plan against what Stripe holds now."
  );
}

function OperationsTable({ operations }: { operations: readonly PublishOutcomeOperation[] }) {
  return (
    <ConsoleDataTable<PublishOutcomeOperation>
      label="Publish operations"
      columns={[
        { key: "sequence", header: "#", cell: (row) => row.sequence },
        { key: "kind", header: "Operation", cell: (row) => row.kind },
        { key: "lookupKey", header: "Lookup key", cell: (row) => row.lookupKey ?? "—" },
        { key: "status", header: "Status", cell: (row) => row.status },
        { key: "error", header: "Error", cell: (row) => row.error ?? "—" },
      ]}
      // `ConsoleDataTable`'s `rows` is mutable (`T[]`) since it is normally
      // fed a freshly-fetched page; this component's own prop is `readonly`
      // because nothing here ever mutates it, so a spread bridges the two.
      rows={[...operations]}
      // `sequence` is unique per attempt (0038's ordering column) —
      // reproduced here rather than a synthetic index so a row's key
      // survives a re-sort.
      rowKey={(row) => String(row.sequence)}
      rowLabel={(row) => `${row.kind} ${row.lookupKey ?? ""}`.trim()}
      total={operations.length}
      page={1}
      // No caller ever paginates this: an attempt's operation count is the
      // plan's own operation count, already bounded by `publish-guards.ts`'s
      // breadth guard, not an open-ended list that needs paging.
      pageSize={Math.max(operations.length, 1)}
      onPageChange={() => {}}
      state={{ kind: "ready" }}
      emptyMessage="No operations were recorded for this attempt."
    />
  );
}

/**
 * The orphan list — see this module's header on why the parity check cannot
 * find these on its own. Rendered as a destructive `Callout`, not a plain
 * list: an orphan is a Price that is ACTIVE and billing right now, not a
 * cosmetic inconsistency, and the visual weight should say so.
 */
function OrphansCallout({ orphans }: { orphans: readonly PublishOutcomeOrphan[] }) {
  if (orphans.length === 0) return null;
  return (
    <Callout role="alert" variant="destructive">
      <CalloutTitle>Orphaned Stripe prices</CalloutTitle>
      <CalloutDescription>
        This attempt&apos;s log believes these Prices were archived, but Stripe still reports them active. The
        nightly parity check cannot see this on its own — it only compares Prices with a lookup key, and these no
        longer carry one. Archive them directly in Stripe, or re-plan and publish again once you have confirmed
        nothing is still subscribed to them.
      </CalloutDescription>
      <ul className="mt-2">
        {orphans.map((orphan) => (
          <li key={orphan.priceId}>
            {orphan.priceId}
            {orphan.lookupKey ? ` (last known lookup key: ${orphan.lookupKey})` : ""} is still active in Stripe.
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export function PublishOutcome({
  attemptId,
  mode,
  outcome,
  promoted,
  operations,
  orphans,
  replanHref,
}: PublishOutcomeProps) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2>Publish attempt {attemptId}</h2>
        <p role="status">{outcomeSummary(outcome, operations)}</p>
      </div>

      <OrphansCallout orphans={orphans} />

      {/* No operations to show for an aborted attempt — `executePublish`
          never entered `plan.operations`, so the log has nothing for this
          attempt id and a table here would render a confusing "no
          operations" empty state for an event that has nothing to do with
          operations at all. */}
      {outcome === "aborted" ? null : <OperationsTable operations={operations} />}

      {/* Re-plan, never retry — see this module's header. Hidden on a
          succeeded outcome: the revision was promoted and there is nothing
          to re-plan against yet. */}
      {outcome === "succeeded" ? null : (
        <div>
          <Button asChild>
            <Link href={replanHref}>Re-plan</Link>
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            {promoted
              ? `Stripe ${mode} matches the new revision.`
              : "Re-planning observes Stripe fresh rather than reusing this plan, which may reference Stripe " +
                "objects that have since moved."}
          </p>
        </div>
      )}
    </section>
  );
}
