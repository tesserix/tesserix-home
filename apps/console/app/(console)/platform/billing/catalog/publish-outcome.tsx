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
// optional politeness, per `publish-view.tsx`'s identical note:
// `PublishAttemptOutcome` reaches `publish-repo.ts`, which is `server-only`
// and pulls in `pg` through `tesserixTx`. A VALUE import of that shape here
// would drag the graph into the browser bundle — `tsc` and `vitest` both
// pass, only `next build` catches it.
//
// `orphans.ts`'s own `Orphan` is deliberately NOT imported: this surface
// declares `PublishOutcomeOrphan` (below) as the trimmed shape it renders,
// and importing `Orphan` merely to restate the relationship in a type
// position would put a `server-only` module on this file's import graph for
// documentation's sake. The relationship is recorded in that interface's
// doc comment instead.
import type { PublishAttemptOutcome } from "@/lib/db/publish-repo";
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
 * # The fourth state: an attempt with no verdict at all
 *
 * `publishAction`'s return value is always resolved, so for most of this
 * component's life there were three outcomes. Reading a PERSISTED attempt
 * back (tesserix-home#410) adds a fourth: `outcome: null`, an attempt whose
 * row was written by `startPublishAttempt` and never closed by
 * `finishPublishAttempt` — a publish that crashed mid-flight.
 *
 * That state is rendered, not hidden, and it is deliberately NOT called
 * "failed": the log does not record that it failed, it records nothing at
 * all about how it ended, and a status line that said "failed" would assert
 * more than is known. What IS known is exactly what the three sections
 * above already establish — some operations may have reached Stripe (the
 * table says which), nothing was promoted (promotion only ever follows a
 * `"succeeded"` outcome), and the recovery is to re-plan. It is also the
 * single shape most likely to have stranded an orphan, since dying between
 * a `replace_price`'s create and its archive is precisely how one is made,
 * which is why its copy points at the orphan callout above.
 *
 * # Consistency with `publish-view.tsx`
 *
 * The `"succeeded"` / `"aborted"` copy below is worded to match
 * `publish-view.tsx`'s `outcomeMessage` (T4's copy, corrected 2026-08-28)
 * rather than say the same thing a different way — a surface a reader might
 * see both of, in either order, should never read like two accounts of one
 * event. The `"failed"` copy extends that same account with what THIS
 * surface adds beyond a status line: the operation table and the orphan
 * check. The `null` copy reuses the `"failed"` copy's own two sentences
 * about promotion and recovery verbatim in substance, for the same reason:
 * they are the same two facts.
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
 * What `findOrphans` reports, trimmed to what this surface shows.
 * `source` stays REQUIRED, matching `Orphan` (`orphans.ts`) exactly:
 * `findOrphans` always populates it from `entry.source`, so no real row
 * ever lacks one, and narrowing it to optional here would be a type with no
 * caller who benefits from the narrowing.
 */
export interface PublishOutcomeOrphan {
  readonly priceId: string;
  readonly lookupKey: string | null;
  readonly source: string;
}

export interface PublishOutcomeProps {
  readonly attemptId: string;
  readonly mode: StripeMode;
  /** `null` when the attempt never recorded a verdict — a publish that
   *  crashed between `startPublishAttempt` and `finishPublishAttempt`. The
   *  session path (`publishAction`'s return value) can never produce one;
   *  reading a PERSISTED attempt back (tesserix-home#410) can, because
   *  `PublishAttemptOutcome | null` is what the log actually stores. The
   *  status line below renders its own copy for that case rather than
   *  coercing it into a verdict the log never recorded — see this module's
   *  "fourth state" section. */
  readonly outcome: PublishAttemptOutcome | null;
  /** Whether `publishAction` promoted the revision — always `false` for a
   *  `"failed"`, `"aborted"` or unresolved (`null`) outcome, since
   *  promotion only ever follows a `"succeeded"` one; see this module's
   *  header. */
  readonly promoted: boolean;
  /** Every operation the attempt's write-ahead log recorded, in `sequence`
   *  order — empty for `"aborted"`, since `executePublish` never entered
   *  `plan.operations` in that case. An unresolved (`null`) attempt is NOT
   *  that case: it entered the loop and its rows are the only record of
   *  what reached Stripe. */
  readonly operations: readonly PublishOutcomeOperation[];
  /** Orphans found by the automatic post-failure check. Empty on anything
   *  other than a failed attempt with an incomplete `replace_price`. */
  readonly orphans: readonly PublishOutcomeOrphan[];
  /** Where "Re-plan" sends the operator — the catalog surface, so it is a
   *  prop rather than a hardcoded path. */
  readonly replanHref: string;
}

/**
 * The status line. Three recorded outcomes plus the unrecorded one, four
 * different truths — the same discipline `publish-view.tsx`'s
 * `outcomeMessage` documents, and the `"succeeded"` / `"aborted"` sentences
 * below are worded to match it rather than restate the same fact
 * differently.
 */
function outcomeSummary(
  outcome: PublishAttemptOutcome | null,
  operations: readonly PublishOutcomeOperation[],
): string {
  if (outcome === null) {
    return (
      "This attempt never recorded an outcome. The log does not say it failed — it says nothing at all about how " +
      "it ended, which is what a publish that stopped between starting and finishing leaves behind. Some of its " +
      "operations may already have been written to Stripe; the table below is the write-ahead log's record of " +
      "which. This attempt was NOT promoted — the previous revision is still published. An attempt that stops " +
      "mid-flight is the shape that can strand an orphaned Stripe price, so read any orphan warning above with " +
      "that in mind. Re-plan against what Stripe holds now."
    );
  }
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
 * find these on its own.
 *
 * Exported, unlike this file's other internal parts, because an orphan
 * OUTLIVES the attempt that stranded it: `findOrphans` is mode-scoped, so a
 * page load can have orphans to show and no unresolved attempt to hang them
 * off (tesserix-home#410, Decision 2). `authoring-panel.tsx` mounts this on
 * its own for exactly that case, rather than inventing a second orphan
 * rendering that could drift from this one. Rendered as a destructive `Callout`, not a plain
 * list: an orphan is a Price that is ACTIVE and billing right now, not a
 * cosmetic inconsistency, and the visual weight should say so.
 */
export function OrphansCallout({ orphans }: { orphans: readonly PublishOutcomeOrphan[] }) {
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
          operations at all.

          An unresolved (`null`) attempt falls on the OTHER side of this
          test on purpose: it did enter the loop, so its write-ahead rows
          are the only evidence of what reached Stripe, and they are exactly
          what the status line above tells the reader to consult. */}
      {outcome === "aborted" ? null : <OperationsTable operations={operations} />}

      {/* Re-plan, never retry — see this module's header. Hidden on a
          succeeded outcome: the revision was promoted and there is nothing
          to re-plan against yet. An unresolved (`null`) attempt is not
          succeeded, so it gets the control — and its `promoted` is `false`,
          so it gets the "Re-planning observes Stripe fresh" caption, which
          is the right one: whatever that attempt did to Stripe, only a
          fresh observation can say. */}
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
