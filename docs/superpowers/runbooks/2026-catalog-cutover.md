# Runbook: moving plan-catalog authority from `billing-bootstrap` to the console

**Status as of 2026-08-28.** This is a sequence, not a single action — the risk in
this cutover is almost entirely in the ORDER things happen, not in any one step
being hard. Read the whole thing before running anything, especially step 4: it
corrects a step in the original task brief that would have destroyed the evidence
a live go-live decision now depends on.

**Scope.** This runbook gets the console into a state where it can safely publish
to `test`, and states precisely what stands between that and publishing to `live`.
It does **not** retire `billing-bootstrap`, and it does not touch `mark8ly/catalog.go` —
see "Out of scope" at the end.

**Terms used below:**
- **mode** — Stripe `test` or `live`, per `lib/billing/stripe-read.ts`'s `StripeMode`.
- **clean** — the nightly parity check's verdict (`parity.ts`'s `compareCatalogToStripe`)
  for one mode: catalog and Stripe agree.
- **the observation window** — the run of consecutive `clean` days tracked by
  `readWindowStatus` (`lib/db/plan-catalog-repo.ts`), which a separate go-live
  decision is blocked on.
- **dry run** — `catalog-bootstrap.mjs --dry-run`, added on this branch. It performs
  the same reads and the same plan computation as a real bootstrap and writes
  nothing to Stripe. Its output is line-for-line comparable to a real run except
  for the `dryRun` field itself.

---

## Step 1 — Confirm the schema is where this runbook assumes it is

**Do this first.** Everything below assumes migrations through `0038_publish_operations.sql`
are applied. Don't take that on faith — the brief this runbook replaces named
`0036` as the last one, and it was already three migrations stale by the time this
was written.

**Run:**

```sql
select version from schema_migrations order by version desc limit 10;
```

**Correct answer:** the highest `version` returned is `38` (or higher, if migrations
have shipped since this runbook was written — check `apps/web/db/migrations/` for
the current top number before trusting `38` specifically). If the highest applied
version is lower than the highest file in `apps/web/db/migrations/`, stop here;
nothing past this point is safe to run against a schema older than the code
assumes.

**Rollback:** this step runs no write. Nothing to roll back.

---

## Step 2 — Confirm `publish-catalog` exists and is assigned

The publish control is withheld from every operator — including whoever runs
this cutover — until the Zitadel role `publish-catalog` exists and is granted.
This gate is enforced in code, not just UI: `actions.ts`'s publish action calls
`checkOperatorCapability(session, "publish-catalog")` in addition to `"billing"`
before it will touch a plan (see `actions.ts` around the "BOTH, in this order"
comment). An operator without it can see the catalog and the draft editor but
never the publish button — `authoring-panel.tsx` renders an explicit withheld
message in that case, not a broken button.

**Verify:**
1. In Zitadel, confirm the `publish-catalog` role exists on the console project
   and is assigned to the operator(s) who will run this cutover.
2. As that operator, load `/platform/billing/catalog`. Confirm the publish
   control is present and enabled, not withheld.

If you only have `billing` and not `publish-catalog`, you will see the message
text `publish-catalog capability` on the page — that string is asserted directly
in `authoring-panel.render.test.tsx` and `page.test.tsx`, so if you see it,
the role assignment has not taken effect yet (check Zitadel, then reload —
session claims may be cached).

**Rollback:** this step grants a role; nothing to roll back. If the wrong
operator gets it by mistake, revoke it in Zitadel — no console state changes
as a result of holding the role, only of using it.

---

## Step 3 — Run the spec's experiments against test mode, if not already recorded

The design spec (`docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`,
§0) names experiments whose answers shape the operation model — e.g. that
`currency_options` merges rather than replaces, and that an existing currency's
amount is immutable once set. `publish-plan.ts` and `publish-guards.ts` are
written assuming those answers are correct.

**Verify:** check spec §0 for whether these experiments are marked as run and
their answers recorded. If they are, this step is already done — skip it.
If not, do not proceed past this point until they are: the guard thresholds in
`publish-guards.ts` (magnitude, breadth) are calibrated against the assumption
that these behaviors are as documented, and a wrong assumption here would
invalidate every verification step that follows.

**Rollback:** experiments against test mode are non-destructive reads/writes of
throwaway data; no rollback needed beyond whatever cleanup the experiment itself
specifies in the spec.

---

## Step 4 — Do NOT wipe test mode. Read this before doing anything else with test.

**This step exists to REPLACE an instruction, not add one.** An earlier draft of
this cutover said to wipe test mode via the Stripe Dashboard before bootstrapping
it fresh. That instruction is now wrong and must not be followed, for reasons
specific to today's state:

- **Test mode is not empty.** It holds mark8ly's live catalog under 42
  `mark8ly_*` lookup keys — verify with a `stripe prices list --limit 100`
  or the equivalent read against the test key, filtering for the `mark8ly_`
  prefix. This is real catalog data another system depends on, not scratch data.
- **A nightly parity CronJob (`console-parity-check`) is running in the cluster**
  and currently reports `clean` for both `test` and `live`.
- **An observation window that a separate go-live decision is blocked on started
  2026-08-27** and is only a day or two old as of this writing. It requires
  7 consecutive `clean` days on **both** modes (see step 6). Wiping test mode
  resets this window to zero and destroys the evidence already accumulated —
  there is no way to recover a day of `clean` history once the underlying data
  it was measured against is gone.

**What wiping would cost, concretely:** every day of parity evidence collected
since 2026-08-27, plus however many days it takes to reaccumulate them, plus
whatever confusion `mark8ly_*` lookup keys silently reappearing (or not) causes
downstream in the meantime.

**If a wipe-and-rebootstrap rehearsal is still wanted** — to prove the bootstrap
path works end to end on a genuinely empty account — it belongs in a **disposable
sandbox Stripe account**, created and destroyed for exactly that purpose, never
in `test` or `live`. Note also that these Stripe accounts are sandboxes: "wipe"
is not an operation Stripe offers on a sandbox in the way the Dashboard's "delete
test data" implies for a classic test/live pair — a sandbox is deleted outright,
not selectively cleared. Treat a rehearsal sandbox as fully disposable, and never
point it at anything with a lookup-key prefix that overlaps `test` or `live`.

**Verification for this step:** there is nothing to run — it is a decision not
to act. The check is procedural: confirm whoever executes this runbook has read
this section before touching test mode in any destructive way.

**Rollback:** N/A — this step is "don't", not "do".

---

## Step 5 — Rehearse, then run, the console's first publish against test

Because test mode already holds the mark8ly catalog (step 4), the console's
first publish against it is **not** a 42-price creation. The draft the console
computes should converge close to what's already there — expect a **small or
near-empty plan**, not a bootstrap-shaped one. A plan showing anything close to
42 creations against `test` at this stage is itself a signal something is wrong
(wrong mode, empty draft, or a `stripe prices list` page that came back
truncated) — stop and investigate rather than publish it.

**Rehearse first, unconditionally.** Every step below that would write to Stripe
gets a dry run first — this one included:

```bash
pnpm --filter console build:bootstrap
node dist/catalog-bootstrap.mjs --mode=test --dry-run
```

Expect output shaped like:

```json
{"job":"plan-catalog-bootstrap","mode":"test","outcome":"ok","force":false,"dryRun":true,"productsCreated":3,"pricesCreated":42,"skipped":0}
```

Read `productsCreated`/`pricesCreated`/`skipped` against what you already know
about test mode's contents from step 4. If test mode already holds mark8ly's
catalog, a dry run reporting 42 creates and 0 skips means the bootstrap script's
lookup-key matching isn't finding the existing prices — stop and find out why
before running anything for real. (Note: `catalog-bootstrap.mjs` is the
bootstrap path documented in `docs/superpowers/plans/2026-08-27-catalog-bootstrap.md`,
a *separate* write path from the console's own publish flow in
`/platform/billing/catalog` — read which one you intend to exercise. The
console's own publish plan is previewed in the UI's publish-plan panel before
any confirmation, which is its own form of dry run and should also be read
carefully before confirming.)

**Then run for real** (console UI, `/platform/billing/catalog`, `test` mode
selected): review the previewed publish plan, confirm any guard prompts
(`publish-guards.ts` — magnitude over 25% or breadth over the configured
thresholds ask for a typed confirmation; mode and currency-coverage breaches are
refused outright and cannot be confirmed past), and publish.

**Verify:** the publish outcome screen shows the plan executed with no
unexpected orphans (see step 5a below), and the next nightly parity run reports
`clean` for `test`.

**Rollback:** publishing is not undo-able in the sense of reverting Stripe state
automatically — a replaced Price stays archived and a re-publish of a prior
revision mints a new Price rather than restoring the old one (this is stated in
the UI deliberately, per the design spec, so operators don't assume an undo that
doesn't exist). If a publish went wrong, the recovery path is a **new** publish
from a corrected draft, not a revert.

### Step 5a — Check for orphans after every write, every time

`findOrphans` (`lib/billing/orphans.ts`) exists because the nightly parity check
**structurally cannot** see one specific failure mode: a `replace_price`
operation that creates a new Price and moves the lookup key onto it, but whose
matching archive of the old Price never lands (crash, failed call). The old
Price is left `active: true` with **no lookup key at all** — and
`compareCatalogToStripe` only ever joins on `lookup_key`, so it has nothing to
compare that Price against and reports `clean`, correctly by its own rules, while
that abandoned Price keeps billing any Subscription still attached to it.

**The publish outcome screen is the only place this surfaces.** It is not
optional reading — check it after every publish, not just this one.

**Verify:** the publish outcome screen (`publish-outcome.tsx`) reports zero
orphans, or names them explicitly if not.

**Rollback:** an orphan is a leftover active Price with a live billing
relationship possibly still attached — it is not something the console can
archive for you automatically today. Resolving one is a manual Stripe
operation (archive the orphaned Price id, after confirming no subscription
still depends on it) and is unaffected by everything else in this runbook.

---

## Step 6 — Soak: leave the nightly check running, watch both modes

Live is **already bootstrapped** — `0037_publish_catalog_to_live.sql` published
the baseline revision to live, and it was bootstrapped into Stripe: 3 products
and 42 prices in account `acct_1SgwbFCyiazmanuP`. There is no "bootstrap live"
step remaining in this runbook; that already happened. What remains for live is
gated separately (step 7).

**The gate this step is actually watching for:** 7 consecutive days where
**both** `test` and `live` report `clean` — not test alone. Get this right; a
separate issue is blocked on this exact condition, and reading it as "7 days for
test" (the original brief's wording) under-specifies it in a way that could
trigger a go-live decision on incomplete evidence.

**Verify:**

```ts
readWindowStatus() // lib/db/plan-catalog-repo.ts
```

or the equivalent read exposed on `/platform/billing/catalog`'s observation
window panel. Correct answer, once the gate is met: both `test` and `live` show
7 consecutive `clean` days ending on the same day (a `clean` streak on one mode
that resets due to the other mode going `drifted` does not satisfy the gate,
even if the unaffected mode's own streak looks long enough in isolation).

**Rollback:** this step is passive — there is nothing to run, only to wait for
and monitor. If either mode goes non-`clean` during the window, the window
resets by definition of "consecutive"; investigate the drift (probably via the
publish outcome or orphan check) before assuming the count will recover on its
own.

---

## Step 7 — Enabling live publishing from the console (a decision, not a task)

Live publishing is refused **in code**, not by convention:
`publish-guards.ts`'s `checkMode` returns a refusal for any mode other than
`"test"`, with a message stating publishing to that mode is refused in v1. This
is deliberate — the header comment on that function cites an hour lost to a
live/test key mix-up on 2026-08-27, and notes live's first console-driven
publish will be the largest single action this tool has ever taken. Lifting the
guard is a code change made after a deliberate decision to do so, once the soak
gate in step 6 is satisfied and whoever owns that decision has signed off — it
is explicitly not something this runbook authorizes on its own.

**Verify (before considering this open):** confirm step 6's gate is met, and
confirm there is an explicit decision on record to lift the guard (not just
"the window closed"). If both hold, lifting the guard is: remove or relax
`checkMode`'s refusal for `"live"`, exercise a dry run against live first (see
step 5's pattern — the same `--dry-run` flag applies to
`node dist/catalog-bootstrap.mjs --mode=live --dry-run` if that path is used
instead of the console's own publish flow), then publish for real and re-run
step 5a's orphan check.

**Rollback:** irreversible in the same sense as any publish (step 5's rollback
note applies identically) — but the guard itself is trivially reversible: put
the refusal back in `checkMode` if live publishing turns out to have been
enabled prematurely. That does not undo any Stripe writes already made under
the lifted guard; it only prevents new ones.

---

## Out of scope for this runbook

- **Retiring `billing-bootstrap`.** That CLI lives in `mark8ly`, a different
  repo, and `mark8ly/catalog.go` has three runtime readers per the design spec's
  inventory (§10). Retiring it needs its own inventory-driven task, only after
  live has converged through the console at least once (step 7).
- **Rollback-of-a-publish as a feature.** Not built, deliberately — see step 5's
  rollback note. Re-publishing a prior revision is expressible but mints new
  Stripe objects; it is not an undo, and the UI says so.
- **`pricing-data.ts` on the marketing site.** It remains a second author of
  catalog data outside this system entirely; a separate issue should exist
  before this cutover is treated as "done" in any broader sense.
