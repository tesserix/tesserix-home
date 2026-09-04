import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `../page.tsx`'s identical comment.
import {
  resolveState,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { dbReadError, stripeUnavailableMessage } from "@/lib/db-read-error";
import { requiresCapability } from "@/lib/internal-access";
import { PlatformApiError } from "@/lib/platform-api";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readCatalogRows,
  readLatestRuns,
  readLivePublication,
  readModeDivergence,
  readRevisionRows,
  readWindowStatus,
  type CatalogRow,
  type LivePublication,
  type ModeDivergence,
  type PairLatestRun,
  type ParityWindowStatus,
} from "@/lib/db/plan-catalog-repo";
// A VALUE import, not `import type` — `currentDraft` runs HERE, server-side,
// same as every other read on this page. `publish-repo.ts` carries its own
// `server-only`; see that module's header for why a client component
// reaching it is exactly the mistake this page's own comments warn every
// client sibling (`catalog-views.tsx`, `authoring-panel.tsx`) away from.
import {
  currentDraft,
  latestPublishAttempt,
  operationsForAttempt,
  type PublishAttempt,
  type PublishOperationRow,
} from "@/lib/db/publish-repo";
// A VALUE import for the same reason `currentDraft` above is one, and with
// one extra thing at stake: `orphans.ts` is `server-only` and reaches BOTH
// `pg` (through `archivedStripePriceIds`) and `stripe` (through
// `stripe-read.ts`). Calling it HERE, in a server component, is correct;
// letting the module — or its `Orphan` type — travel on to `AuthoringPanel`
// would put both drivers on the browser bundle's import graph, and `tsc`
// and `vitest` would both stay green while `next build` failed with
// `Can't resolve 'net'`. What crosses that boundary below is
// `PublishOutcomeOrphan`, the trimmed shape `publish-outcome.tsx` declares
// precisely so `Orphan` never has to.
import { findOrphans } from "@/lib/billing/orphans";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
// `isStripeReadUnavailable` is a VALUE import, and safely: this module is
// already on this server component's value graph (`STRIPE_MODES`), and a
// server component is the correct side of the boundary for it. Nothing
// below hands it, or anything from it, to `AuthoringPanel`.
import { isStripeReadUnavailable, STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { CatalogViews } from "./catalog-views";
import { AuthoringPanel } from "./authoring-panel";
// Client components, rendered as ELEMENTS from this server component — never
// called as functions. Every export of a `"use client"` module is a client
// reference here; see `catalog-surface.tsx`'s `draftRows` for what that costs
// when a page needs a value out of one, and this file's `resolveState` import
// comment for the same trap with a helper.
import { CatalogSurface } from "./catalog-surface";
import { PromoCodesPanel } from "./promo-codes-panel";
// Type-only: `promo-codes-panel.tsx` is a `"use client"` module, so a VALUE
// import of anything but the component itself would be a client reference
// this server component could not call — the trap `draftRows`' comment in
// `catalog-surface.tsx` records.
import type { PromoCodeView } from "./promo-codes-panel";
import { listPromoCodes, readStripeCoupons } from "@/lib/db/promo-codes-repo";
import { ObservationStrip } from "./observation-strip";
import { ModeDivergenceLine } from "./mode-divergence-line";
// Type-only, deliberately: `publish-outcome.tsx` carries a load-bearing
// `"use client"`, and these two are the display shapes this page maps its
// server-side rows INTO — never a value this server component calls.
import type {
  PublishOutcomeOperation,
  PublishOutcomeOrphan,
} from "./publish-outcome";

/**
 * The plan catalog's console surface — tesserix-home#326's read-only half
 * ("read-only console surface behind the `billing` capability") plus, as of
 * task 9 (tesserix-home#396), the authoring surface `AuthoringPanel` mounts
 * beside it.
 *
 * # This page reads Stripe once, and writes to it never
 *
 * This heading used to read "imports nothing from Stripe". That claim no
 * longer holds, and the honest version is worth stating rather than quietly
 * dropping: eight of this file's NINE reads (seven independent, two
 * dependent — see below) touch only `tesserix-postgres` and never publish
 * anything, but the ninth — `readOrphans` — does read Stripe, through
 * `findOrphans`. It is still a read: it lists active Prices and cross-references them against what this
 * catalog's own log believes it archived. Nothing on this page writes to
 * Stripe. `AuthoringPanel` and its children are a different
 * story on purpose: `DraftEditor`, `PublishView` and `PublishOutcome` are
 * CLIENT components whose server actions (`actions.ts`) are the write path
 * — Stripe reads, Stripe writes, the guards, the operation log — with their
 * own capability checks (`checkOperatorCapability`) independent of anything
 * this page decides. This page reads the catalog and hands `AuthoringPanel`
 * what it needs to decide what its OWN controls may do; it does not do any
 * of that deciding itself.
 *
 * # SEVEN independent reads, not one
 *
 * Same discipline `../page.tsx` (estate billing) and `../../audit-log/page.tsx`
 * apply: `Promise.allSettled`, not `Promise.all`, so a failure in one read
 * (say, the parity-runs table) cannot blank the catalog table that read
 * cleanly. An operator deciding whether #327's revocation is safe needs the
 * catalog to render even on a day the runs table is having a bad time, and
 * vice versa. The fourth read — task 2R — is who published the mode's
 * currently-live revision and when; the same rule applies to it: a failed
 * publication read must not take down the catalog table or the observation
 * window. The FIFTH — task 9's `readDraft` — is whether a draft exists at
 * all; a failed draft read must not take down any of the other four either,
 * and is narrowed into its own `SurfaceState` (`draftState`) that
 * `AuthoringPanel` alone reacts to.
 *
 * The SIXTH and SEVENTH arrived with tesserix-home#410, when the publish
 * outcome stopped living only in `AuthoringPanel`'s React state — where it
 * survived exactly one page load:
 *
 * - `readAttempt` is the mode's most recent publish attempt. It exists so an
 *   operator who publishes, closes the tab, and comes back still learns that
 *   the publish failed, instead of finding a page that looks like nothing
 *   ever happened. It must not take the catalog down, because the catalog is
 *   what they came back to look at.
 * - `readOrphans` is the archived-in-our-log-but-still-active-in-Stripe
 *   check. It is the one failure the nightly parity run STRUCTURALLY cannot
 *   see (`orphans.ts`'s header explains why), so this page is its only
 *   surface. It is also the only read here that leaves the estate, which is
 *   exactly why it is isolated: a Stripe outage must degrade to "the orphan
 *   check is unavailable" and touch nothing else on the page.
 *
 * The heading's "seven" is the count that section was written at, and it is
 * no longer the count: #521's `readPromoCodes` made it eight and #527's
 * `readDivergence` makes it NINE. The last is the odd one out and worth
 * naming — every other read here is scoped to the `?mode=` the operator is
 * looking at, and that one is a question ABOUT both modes ("does test still
 * serve what live serves?"), so it takes no mode and its answer does not move
 * when the toggle does. It is still a sibling in the same array for the same
 * reason as the rest: an operator whose catalog read failed must still learn
 * whether test's parity evidence stands for live, and vice versa.
 *
 * Two further reads sit OUTSIDE the `allSettled` array, because each depends
 * on one of the nine having named an id first: `readDraftRows` (on
 * `readDraft`) and `readOperations` (on `readAttempt`). They are the same
 * shape as each other and settle independently in their own `try`/`catch`,
 * which is what makes the total ELEVEN reads and eleven narrowing
 * functions — nine siblings and two dependents.
 *
 * # Reads tesserix-postgres directly, like `audit-log`, unlike `billing`
 *
 * The estate billing page federates through `platform-api`, whose 403/501
 * contract `billingReadError` narrows. This page's reads are the
 * console's OWN store — no federation, no operator token — so they go through
 * `dbReadError` instead, the same narrowing `audit-log/page.tsx`'s
 * `console_audit_log` read uses. See `@/lib/db-read-error` for why the rule is
 * about the data source, not the feature.
 *
 * # No page-level capability gate
 *
 * Same as every other console page: `middleware.ts` only establishes that the
 * caller holds a valid session and is an internal operator, and
 * `packages/console-core/src/routes.ts`'s `capability: "billing"` on this
 * route's entry gates DISCOVERABILITY in the rail and palette, not viewing.
 * See `platform/health/page.tsx`'s doc comment, which states this precedent
 * for the whole app.
 */

/** #327's number. Owned by the caller, per `readWindowStatus`'s own doc
 *  comment — this page is the one caller that gets to say 7. */
export const OBSERVATION_WINDOW_DAYS = 7;

export const WINDOW_SURFACE = "the parity observation window";
export const CATALOG_SURFACE = "the plan catalog";
export const RUNS_SURFACE = "the latest parity runs";
export const PUBLICATION_SURFACE = "the catalog's live publication";
/** Task 9's fifth surface — whether a draft exists at all. Named separately
 *  from `DRAFT_ROWS_SURFACE` below: "does a draft exist" and "what does it
 *  contain" are two different reads (`currentDraft` vs. `readRevisionRows`),
 *  and a failure in the second must name itself distinctly from the first —
 *  the same "name the table that actually failed" reasoning `windowReadError`
 *  through `publicationReadError` already apply. */
export const DRAFT_SURFACE = "the current draft";
export const DRAFT_ROWS_SURFACE = "the draft's priced rows";
/** The mode's most recent publish attempt — tesserix-home#410's first new
 *  surface, and the sixth of the seven INDEPENDENT reads. Named for the attempt, not for the outcome it carries: the read
 *  can fail while the mode has a perfectly good attempt to report, and the
 *  copy an operator sees has to say which of those two happened. */
export const ATTEMPT_SURFACE = "the latest publish attempt";
/** The seventh independent read, and the only surface on this page whose
 *  failure is not always a `tesserix-postgres` failure: `findOrphans` reaches Stripe as well. Named
 *  as the CHECK rather than as "Stripe" so an unavailable message says what
 *  the operator has lost — the orphan check — rather than naming a
 *  dependency they cannot act on. */
export const ORPHANS_SURFACE = "the orphaned Stripe price check";
/** The second of the two DEPENDENT reads — the ninth surface in all —
 *  standing to `ATTEMPT_SURFACE` exactly as `DRAFT_ROWS_SURFACE` (the first
 *  dependent one) stands to `DRAFT_SURFACE`: "which attempt was last"
 *  and "what did it actually do" are two reads, and a failure in the second
 *  must name itself distinctly from the first — an operator who can see the
 *  attempt but not its operations is in a different position from one who
 *  can see neither. */
export const OPERATIONS_SURFACE = "the publish attempt's operations";

/** #521 T4's read: the promo-code definitions and the coupons minted for
 *  them. One surface name for both tables, because an operator loses the
 *  same thing whichever of the two failed — the tab has nothing to show. */
export const PROMO_CODES_SURFACE = "promo codes";

/** #527's read. Named for the COMPARISON rather than for either mode: what an
 *  operator loses when it fails is the answer to "does test still evidence
 *  live", and naming one mode would suggest that mode's catalog is the thing
 *  that could not be read. */
export const DIVERGENCE_SURFACE = "the test-vs-live catalog comparison";

/** Query params this page reads. Matches `TenantSearchParams`'s shape —
 *  `string | string[] | undefined` is what Next actually hands a page. */
export type CatalogSearchParams = Record<string, string | string[] | undefined>;

/**
 * Which mode's catalog to show — `?mode=test` or `?mode=live`, defaulting to
 * `live` per the task's brief.
 *
 * An unrecognised or repeated value falls back to `live` rather than
 * throwing or rendering nothing: a hand-edited URL is not the operator's
 * fault, and `live` is the mode #327's revocation is actually about.
 */
export function readCatalogMode(searchParams: CatalogSearchParams): StripeMode {
  const raw = searchParams.mode;
  return typeof raw === "string" && (STRIPE_MODES as readonly string[]).includes(raw)
    ? (raw as StripeMode)
    : "live";
}

/**
 * Narrow each read's rejection ONCE, at the point it is caught — `dbReadError`
 * logs the real error server-side, and calling it twice per failure would log
 * the same failure twice. Nine functions, not one, so the log line and the
 * migrations-pending copy each name the table that actually failed rather
 * than a generic "the plan catalog" that leaves an operator guessing which of
 * nine reads broke.
 */
export function windowReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, WINDOW_SURFACE);
}
export function catalogReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, CATALOG_SURFACE);
}
export function runsReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, RUNS_SURFACE);
}
export function publicationReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, PUBLICATION_SURFACE);
}
export function draftReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, DRAFT_SURFACE);
}
export function draftRowsReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, DRAFT_ROWS_SURFACE);
}
export function attemptReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, ATTEMPT_SURFACE);
}
/**
 * The one read here that can fail at Stripe rather than at
 * `tesserix-postgres`, and the only narrowing function that has to ask WHICH.
 *
 * This used to hand everything to `dbReadError` on the reasoning that a
 * Stripe failure is unknowable from here. It is not: `findOrphans` reaches
 * Stripe through `stripe-read.ts`, which refuses a mode whose restricted read
 * key is unset or announces the other mode by throwing
 * `StripeReadUnavailableError` — a named, recognisable class. Falling through
 * produced two wrong things at once, and `live` is this page's DEFAULT mode
 * with no restricted read key provisioned in this estate, so both were the
 * COMMON case rather than an edge:
 *
 * - "Try again shortly", which can never work. No amount of waiting
 *   provisions a credential. Same class of useless-retry copy
 *   `invalidCursorMessage` was written to replace, and this follows its
 *   shape.
 * - A server log reading "failed to read ... from tesserix-postgres" for a
 *   read that never contacted the database at all, sending the next engineer
 *   to the wrong system.
 *
 * The Stripe branch is checked FIRST and logs its own line, for the reason
 * `dbReadError` checks `noOperatorToken` ahead of its own log: the database
 * must not be named for a failure it had no part in.
 */
export function orphansReadError(caught: unknown): SurfaceError | null {
  if (caught !== null && caught !== undefined && isStripeReadUnavailable(caught)) {
    // Server-side only, same as `dbReadError`'s own: this runs in a React
    // Server Component, so it lands in the app's logs and never in the
    // response. The credential's own message names the variable; this line
    // names the surface an operator lost.
    console.error(`[console] failed to read ${ORPHANS_SURFACE} from Stripe`, caught);
    // No `status`: nothing here is a 501 park (the tables are fine) and
    // nothing is a transport failure worth a code. `resolveState` turns a
    // bare message into the `error` state, which is the honest one — the
    // check genuinely cannot answer.
    return { message: stripeUnavailableMessage(ORPHANS_SURFACE) };
  }
  // Everything else — including a genuine `tesserix-postgres` failure inside
  // `archivedStripePriceIds`, which is the other half of this same read —
  // narrows exactly like the other eight.
  return dbReadError(caught, ORPHANS_SURFACE);
}
export function operationsReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, OPERATIONS_SURFACE);
}
export function promoCodesReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, PROMO_CODES_SURFACE);
}
export function divergenceReadError(caught: unknown): SurfaceError | null {
  return dbReadError(caught, DIVERGENCE_SURFACE);
}

/** Thrown by each guarded read below when the console has no database
 *  connection configured at all — distinct from a query that ran and failed,
 *  and from a query against tables that were never migrated. */
function notConfigured(): never {
  throw new PlatformApiError(
    "plan catalog: tesserix database is not configured",
    // `dbReadError` maps this straight through `resolveState`'s 501 branch,
    // the same parked-data-plane state `audit-log`'s console read uses when
    // unconfigured — see that page's `readConsoleEntries` for the identical
    // guard.
    501,
  );
}

async function readWindow(): Promise<ParityWindowStatus> {
  if (!isDatabaseConfigured()) notConfigured();
  return readWindowStatus(OBSERVATION_WINDOW_DAYS);
}

async function readCatalog(mode: StripeMode): Promise<CatalogRow[]> {
  if (!isDatabaseConfigured()) notConfigured();
  // SINGLE-SOURCE ASSUMPTION: `SINGLE_SOURCE` (`source-policy.ts`) is every
  // row this table holds today. This surface has no mode-and-source picker
  // yet, so there is nothing else to name here until a second source's rows
  // exist to choose between.
  return readCatalogRows(mode, SINGLE_SOURCE);
}

/**
 * The promo tab's rows: every definition, INCLUDING the inactive ones, plus
 * what has been minted for each.
 *
 * `includeInactive` is `true` here and nowhere else — `listPromoCodes`
 * excludes them by default precisely so a picker or a redeemer never sees a
 * retired code, and this is the one surface whose job is to show an operator
 * what they have retired. The table marks them.
 *
 * The per-definition coupon read is a loop over `readStripeCoupons`, N+1 by
 * construction. Deliberate, and bounded: this is an operator surface with a
 * handful of rows, not the `/api/v1/promo-catalog` contract endpoint —
 * `readStripeCouponIdsForMode` exists for that one because it serves every
 * definition on every request. Batching here would need a second batched read
 * per mode and would still be two round trips; the honest limit is the row
 * count, and if it ever grows this is the place to notice.
 */
async function readPromoCodes(): Promise<PromoCodeView[]> {
  if (!isDatabaseConfigured()) notConfigured();
  const rows = await listPromoCodes({ includeInactive: true });
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      code: row.code,
      trialExtensionDays: row.trialExtensionDays,
      discount: row.discount,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      maxRedemptions: row.maxRedemptions,
      isActive: row.isActive,
      coupons: (await readStripeCoupons(row.id)).map((coupon) => ({
        mode: coupon.mode,
        stripeCouponId: coupon.stripeCouponId,
      })),
    })),
  );
}

/**
 * #527's read: do `test` and `live` currently serve the same catalog?
 *
 * MODE-INDEPENDENT, and deliberately not passed `mode` — it is a question
 * ABOUT both modes, so a `?mode=` switch must not change its answer. Same
 * `SINGLE_SOURCE` assumption every other read on this page makes.
 *
 * `not_published` is an ordinary answer, never a failure: a mode with no
 * current publication is the state `live` was in for most of this project's
 * life. It is not `null`, and it is not an empty result — see
 * `readModeDivergence` for why it must not be able to read as agreement.
 */
async function readDivergence(): Promise<ModeDivergence> {
  if (!isDatabaseConfigured()) notConfigured();
  return readModeDivergence(SINGLE_SOURCE);
}

async function readRuns(): Promise<PairLatestRun[]> {
  if (!isDatabaseConfigured()) notConfigured();
  return readLatestRuns();
}

async function readPublication(mode: StripeMode): Promise<LivePublication | null> {
  if (!isDatabaseConfigured()) notConfigured();
  // `null` is the normal answer for a mode that has never been published —
  // `live` before #0037, and any future second source or mode before its
  // first publish. It is not a failure and must not be treated like one.
  return readLivePublication(mode);
}

/**
 * Task 9's fifth read: does a draft exist, and what is its id? `null` is the
 * ordinary answer — no operator has started one — never treated as a
 * failure, same discipline `readPublication` above applies to a
 * never-published mode.
 *
 * Deliberately does NOT read the draft's amounts here — that is
 * `readDraftRows` below, a SECOND, independent read `AuthoringPanel` alone
 * reacts to, so a broken draft-rows read cannot take this read (or the six
 * others beside it) down with it. See the module doc comment's "SEVEN
 * independent reads" section.
 */
async function readDraft(): Promise<{ id: string; basedOn: string | null } | null> {
  if (!isDatabaseConfigured()) notConfigured();
  return currentDraft();
}

/**
 * The draft's own priced rows, once `readDraft` has named an id — a read
 * `AuthoringPanel` needs to seed `DraftEditor` with what was actually saved,
 * not the published catalog re-shown as if it were the draft (see
 * `authoring-panel.tsx`'s `buildDraftEditorRows` for why that distinction
 * matters the moment an edit has been saved and the page re-renders).
 *
 * Called OUTSIDE the seven-way `Promise.allSettled` below, on purpose — the
 * same shape, and the same reasoning, `readOperations` records for itself: it
 * depends on `readDraft`'s own result (there is no id to read rows for until
 * that read resolves), so it cannot be a sibling in the same array — but it
 * is still independently settled, in its own `try`/`catch`, so its failure
 * narrows into `draftRowsState` alone and never touches `catalogState`,
 * `windowState`, `runsState`, `publicationState`, `attemptState`,
 * `orphansState` or even `draftState` (which already succeeded by the time
 * this runs).
 */
async function readDraftRows(revisionId: string): Promise<CatalogRow[]> {
  if (!isDatabaseConfigured()) notConfigured();
  return readRevisionRows(revisionId, SINGLE_SOURCE);
}

/**
 * The mode's most recent publish attempt, whatever became of it. `null` is
 * the ordinary answer for a mode nobody has published — `live`, most days —
 * and is never treated as a failure, the same discipline `readPublication`
 * and `readDraft` apply to their own absent rows.
 *
 * Reads the LATEST attempt rather than a named one on purpose: a page load
 * has a mode and no attempt id, and "what happened here last" is the
 * question an operator returning to this page is actually asking.
 */
async function readAttempt(mode: StripeMode): Promise<PublishAttempt | null> {
  if (!isDatabaseConfigured()) notConfigured();
  return latestPublishAttempt(mode);
}

/**
 * Archived-in-our-log-but-still-active-in-Stripe Prices for the mode. An
 * empty list is the ordinary, hoped-for answer and is not a failure.
 *
 * # DELIBERATELY NOT gated on the attempt's outcome. Do not "optimise" it.
 *
 * The obvious-looking saving — only check for orphans when the latest
 * attempt failed — reintroduces the exact bug this read exists to fix, one
 * level down. `findOrphans` is MODE-scoped, not attempt-scoped: it
 * cross-references every archived id in the log for the mode
 * (`archivedStripePriceIds`) against Stripe's active set, so an orphan
 * OUTLIVES the attempt that stranded it and survives a later successful
 * publish. Under that gate the sequence "publish fails and strands a Price →
 * operator re-plans → publish succeeds" would make the stranded Price
 * permanently invisible, and nothing else in the estate can see it: the
 * nightly parity run structurally cannot (`orphans.ts`'s header), so this is
 * its only surface. Worse than the state before this read existed, because
 * it would look deliberate.
 *
 * The cost is one paged Stripe `prices.list` per page load. Accepted: this
 * is an internal console with a handful of operators, it is the same call
 * the nightly parity run already makes, and it is isolated here so a Stripe
 * outage degrades to "the orphan check is unavailable" without touching
 * anything else on the page.
 */
async function readOrphans(mode: StripeMode): Promise<readonly PublishOutcomeOrphan[]> {
  if (!isDatabaseConfigured()) notConfigured();
  // Mapped to the display shape HERE, at the last server-side moment, so
  // `Orphan` — and with it `orphans.ts` — never reaches a prop passed to a
  // client component. See this file's import block for what that costs when
  // it does.
  const found = await findOrphans(mode);
  return found.map((orphan) => ({
    priceId: orphan.priceId,
    lookupKey: orphan.lookupKey,
    source: orphan.source,
  }));
}

/**
 * The attempt's own write-ahead operation log, once `readAttempt` has named
 * an id — the only place an operator can see, per operation, what actually
 * landed in Stripe versus what did not. A `"failed"` attempt has `succeeded`
 * rows in it (the executor continues past a single failure), which is why a
 * summary count would hide exactly the fact that matters.
 *
 * Called OUTSIDE the seven-way `Promise.allSettled` below, for precisely the
 * reason `readDraftRows` is: it depends on another read's result — there is
 * no id to read operations for until `readAttempt` resolves — so it cannot
 * be a sibling in the same array. It is still independently settled, in its
 * own `try`/`catch`, so its failure narrows into `operationsState` alone and
 * never touches `catalogState`, `windowState`, `runsState`,
 * `publicationState`, `draftState`, `orphansState`, or even `attemptState`
 * (which has already succeeded by the time this runs — an operator can see
 * THAT the publish failed even on a day they cannot see what it did).
 */
async function readOperations(attemptId: string): Promise<PublishOutcomeOperation[]> {
  if (!isDatabaseConfigured()) notConfigured();
  const rows = await operationsForAttempt(attemptId);
  // `PublishOperationRow` carries more than this surface shows (idempotency
  // keys, Stripe price ids, timestamps); the display type is deliberately
  // narrower, and narrowing it here keeps that decision on the server side.
  return rows.map((row: PublishOperationRow) => ({
    sequence: row.sequence,
    kind: row.kind,
    lookupKey: row.lookupKey,
    status: row.status,
    error: row.error,
  }));
}

/**
 * Which attempts this surface has any business showing: the UNRESOLVED ones
 * only — `failed`, `aborted`, or an attempt that never recorded a verdict at
 * all. A `succeeded` latest attempt returns `null`.
 *
 * Not a filter for tidiness. A success is ALREADY durably surfaced on this
 * page, by `readPublication` → `CatalogViews`'s publication block: who
 * published which revision, and when. Showing a second, persisted success
 * banner beside it would be two accounts of one event, which
 * `publish-outcome.tsx`'s own "Consistency with `publish-view.tsx`" note
 * treats as a defect. And it would be the WORSE of the two accounts:
 * `PublishOutcome`'s success copy claims "Stripe now matches this revision",
 * a statement about Stripe's CURRENT state that was true at publish time and
 * decays silently as the catalog drifts. Pinning that above the catalog
 * permanently is a stale-success banner, which is its own bug.
 *
 * "Unresolved" needs no extra bookkeeping precisely because this reads only
 * the LATEST attempt: a subsequent successful publish resolves a prior
 * failure automatically, without anything having to go back and clear it.
 *
 * An operator who has just published successfully still gets their receipt —
 * `AuthoringPanel` keeps the live session outcome from `publishAction`, and
 * that wins over this. This only governs what comes BACK on a reload.
 */
export function surfacedAttempt(attempt: PublishAttempt | null): PublishAttempt | null {
  return attempt && attempt.outcome !== "succeeded" ? attempt : null;
}

export default async function PlanCatalog({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}) {
  const mode = readCatalogMode(await searchParams);

  // `allSettled`, not `all`: see the module doc comment above.
  const [
    windowResult,
    catalogResult,
    runsResult,
    publicationResult,
    draftResult,
    attemptResult,
    orphansResult,
    promoCodesResult,
    divergenceResult,
  ] = await Promise.allSettled([
    readWindow(),
    readCatalog(mode),
    readRuns(),
    readPublication(mode),
    readDraft(),
    readAttempt(mode),
    // A SIBLING of the attempt read, never a child of it — see
    // `readOrphans`'s doc comment for the bug that gating it would
    // reintroduce.
    readOrphans(mode),
    readPromoCodes(),
    // Its own slot, like every other read here: a failed comparison must not
    // blank the catalog table or the observation window, and neither of those
    // failing may take this line down with them.
    readDivergence(),
  ]);

  const window = windowResult.status === "fulfilled" ? windowResult.value : null;
  const windowState: SurfaceState = resolveState({
    isLoading: false,
    error: windowResult.status === "rejected" ? windowReadError(windowResult.reason) : null,
    // `window?.pairs` is always `STRIPE_MODES.length * CATALOG_SOURCES.length`
    // entries when the read succeeds — see `readWindowStatus`'s "every pair,
    // always" guarantee — so this can only resolve to `ready` or the
    // error/unavailable states, never `empty`.
    rows: window?.pairs ?? [],
    filtered: false,
  });

  const promoCodes = promoCodesResult.status === "fulfilled" ? promoCodesResult.value : [];
  const promoCodesState: SurfaceState = resolveState({
    isLoading: false,
    error:
      promoCodesResult.status === "rejected"
        ? promoCodesReadError(promoCodesResult.reason)
        : null,
    // Genuinely can be empty: no promo code has been authored yet, which is
    // the state this surface ships in.
    rows: promoCodes,
    filtered: false,
  });

  const divergence = divergenceResult.status === "fulfilled" ? divergenceResult.value : null;
  const divergenceState: SurfaceState = resolveState({
    isLoading: false,
    error:
      divergenceResult.status === "rejected"
        ? divergenceReadError(divergenceResult.reason)
        : null,
    // `readModeDivergence` always resolves to an outcome — including
    // `not_published`, which is an ANSWER and not an absence — so a fulfilled
    // read is always one row and can only be `ready`. The `empty` branch is
    // unreachable in practice and is written this way so the surface cannot
    // start reporting "nothing here yet" if that ever changes.
    rows: divergence ? [divergence] : [],
    filtered: false,
  });

  const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : [];
  const catalogState: SurfaceState = resolveState({
    isLoading: false,
    error: catalogResult.status === "rejected" ? catalogReadError(catalogResult.reason) : null,
    // Genuinely can be empty: a mode with no publication yet (live, most
    // days) has nothing to show, and that is `not_bootstrapped`, not a bug.
    rows: catalog,
    filtered: false,
  });

  const runs = runsResult.status === "fulfilled" ? runsResult.value : [];
  const runsState: SurfaceState = resolveState({
    isLoading: false,
    error: runsResult.status === "rejected" ? runsReadError(runsResult.reason) : null,
    // Same "every pair, always" guarantee as `window` above — `runs` holds one
    // entry per (mode, source) pair whenever the read succeeds, even on a
    // database with zero rows in `plan_catalog_parity_runs`. That "no runs
    // recorded yet" case is a `run: null` entry inside a `ready` state, not an
    // `empty` surface state; `CatalogViews` renders it explicitly.
    rows: runs,
    filtered: false,
  });

  const publication =
    publicationResult.status === "fulfilled" ? publicationResult.value : null;
  const publicationState: SurfaceState = resolveState({
    isLoading: false,
    error: publicationResult.status === "rejected" ? publicationReadError(publicationResult.reason) : null,
    // Genuinely can be `null`: a mode that has never been published (`live`
    // before #0037) has no attribution to show, and that is `empty`, not a
    // bug — `CatalogViews` renders it as a calm sentence rather than a blank
    // or a misleading "published by —".
    rows: publication ? [publication] : [],
    filtered: false,
  });

  const draft = draftResult.status === "fulfilled" ? draftResult.value : null;
  const draftState: SurfaceState = resolveState({
    isLoading: false,
    error: draftResult.status === "rejected" ? draftReadError(draftResult.reason) : null,
    // Genuinely can be `null`: most of the time, nobody has a draft open.
    rows: draft ? [draft] : [],
    filtered: false,
  });

  // Decision 1, applied to the read's result rather than to the query: the
  // reader returns the latest attempt whatever became of it (that is the
  // log's business), and this page decides what it has any business showing
  // (that is the surface's business). See `surfacedAttempt`.
  const attempt = surfacedAttempt(
    attemptResult.status === "fulfilled" ? attemptResult.value : null,
  );
  const attemptState: SurfaceState = resolveState({
    isLoading: false,
    error: attemptResult.status === "rejected" ? attemptReadError(attemptResult.reason) : null,
    // `empty` covers two different-looking cases that want the same
    // treatment — nobody has ever published this mode, and the last publish
    // succeeded — because both mean the same thing here: this surface has
    // nothing of its own to say, and `CatalogViews`'s publication block says
    // whatever there is to say instead.
    rows: attempt ? [attempt] : [],
    filtered: false,
  });

  const orphans = orphansResult.status === "fulfilled" ? orphansResult.value : [];
  const orphansState: SurfaceState = resolveState({
    isLoading: false,
    error: orphansResult.status === "rejected" ? orphansReadError(orphansResult.reason) : null,
    // An empty list is the hoped-for answer, not a bug and not a
    // not-bootstrapped state: it means every Price this catalog's log
    // believes it archived is in fact archived in Stripe.
    rows: orphans,
    filtered: false,
  });

  // The attempt's OWN operations — a dependent read, only attempted once
  // `readAttempt` has actually named an unresolved attempt. See
  // `readOperations`'s doc comment for why this cannot be a sibling inside
  // the `Promise.allSettled` above, and why its failure still cannot touch
  // anything else on this page.
  let operations: readonly PublishOutcomeOperation[] = [];
  let operationsState: SurfaceState = resolveState({
    isLoading: false,
    error: null,
    rows: [],
    filtered: false,
  });
  if (attemptState.kind === "ready" && attempt) {
    try {
      operations = await readOperations(attempt.id);
      operationsState = resolveState({ isLoading: false, error: null, rows: operations, filtered: false });
    } catch (caught) {
      operationsState = resolveState({
        isLoading: false,
        error: operationsReadError(caught),
        rows: [],
        filtered: false,
      });
    }
  }

  /**
   * Everything the persisted-outcome surface needs, assembled server-side and
   * handed to `AuthoringPanel` below. Kept as one
   * named bundle rather than five loose locals so the boundary is obvious:
   * every field here is a plain display shape, and neither `Orphan` nor
   * `PublishOperationRow` — nor the `server-only` modules they come from —
   * appears in it.
   *
   * `promoted` mirrors `actions.ts`'s own `outcome.outcome === "succeeded"`
   * verbatim rather than deriving the same fact a second way. Under Decision
   * 1 a surfaced attempt is never `succeeded`, so this is always `false` in
   * practice; writing it as the mirror anyway means the two cannot drift if
   * that decision is ever revisited.
   */
  const persistedOutcomeProps = {
    persistedOutcome: attempt
      ? {
          attemptId: attempt.id,
          outcome: attempt.outcome,
          promoted: attempt.outcome === "succeeded",
          operations,
        }
      : null,
    attemptState,
    operationsState,
    orphans,
    orphansState,
  };

  // The draft's OWN rows — a second, independent read, only attempted once
  // `readDraft` has actually named an id. See `readDraftRows`'s own doc
  // comment on why this cannot be a sibling inside the `Promise.allSettled`
  // above, and why its failure still cannot touch anything else on this
  // page.
  let draftRows: CatalogRow[] | null = null;
  let draftRowsState: SurfaceState = resolveState({
    isLoading: false,
    error: null,
    rows: [],
    filtered: false,
  });
  if (draftState.kind === "ready" && draft) {
    try {
      draftRows = await readDraftRows(draft.id);
      draftRowsState = resolveState({ isLoading: false, error: null, rows: draftRows, filtered: false });
    } catch (caught) {
      draftRowsState = resolveState({
        isLoading: false,
        error: draftRowsReadError(caught),
        rows: [],
        filtered: false,
      });
    }
  }

  // Read-only for THIS page's own purposes (deciding what `AuthoringPanel`'s
  // controls may attempt) — every server action behind those controls
  // re-checks the identical capability itself (`checkOperatorCapability` in
  // `actions.ts`). Same `!requiresCapability() || hasCapability(...)` shape
  // `crm/[organisation]/page.tsx`'s `canHardDelete` uses, for the identical
  // pre-cutover reason: a role-less `google`-provider session is treated as
  // holding every capability until roles actually arrive with Zitadel.
  // `canDraft` and `canPublish` are each their own independent check — not
  // `canPublish = canDraft && ...` — because `checkOperatorCapability` checks
  // "billing" and "publish-catalog" independently too; nesting them here
  // would make the UI stricter than the server it is meant to mirror.
  const session = await getCurrentSession();
  const canDraft = !requiresCapability() || hasCapability(session?.roles, "billing");
  const canPublish = !requiresCapability() || hasCapability(session?.roles, "publish-catalog");

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Plan catalog"
        description="The published Stripe catalog and the nightly parity check that watches it, per mode."
      />

      {/* Browse and Draft & Publish, with the observation strip and the mode
          toggle above them — see `catalog-surface.tsx` for why those two are
          not inside a tab, and why the tabs are an array. Both panels are
          constructed HERE, from reads this component already did, and handed
          down as elements. */}
      <CatalogSurface
        mode={mode}
        observation={
          <ObservationStrip
            windowStatus={window}
            windowState={windowState}
            runs={runs}
            runsState={runsState}
            windowDays={OBSERVATION_WINDOW_DAYS}
          />
        }
        divergence={
          <ModeDivergenceLine divergence={divergence} divergenceState={divergenceState} />
        }
        draftRows={draftRows}
        catalog={catalog}
        // `surfacedAttempt` has already withheld a `succeeded` attempt, so a
        // non-null one here is exactly an attempt that did not succeed —
        // the same fact that mounts the alert inside the panel, which is the
        // alert an operator sitting on Browse would otherwise never see.
        attemptNeedsAttention={attempt !== null}
        browse={
          <CatalogViews
            mode={mode}
            catalog={catalog}
            catalogState={catalogState}
            publication={publication}
            publicationState={publicationState}
          />
        }
        promoCodes={
          <PromoCodesPanel
            mode={mode}
            codes={promoCodes}
            codesState={promoCodesState}
            // The same two capabilities the catalog half uses, read the same
            // way and — as there — each checked independently rather than
            // nested, because `promo-actions.ts` checks them independently
            // too. `canDraft` is `billing` (authoring a definition touches
            // nothing Stripe has seen) and `canPublish` is `publish-catalog`
            // (minting creates a live, redeemable coupon in a real account).
            canAuthor={canDraft}
            canMint={canPublish}
          />
        }
        authoring={
          <AuthoringPanel
            mode={mode}
            catalog={catalog}
            catalogState={catalogState}
            draftState={draftState}
            draftId={draft?.id ?? null}
            draftRows={draftRows}
            draftRowsState={draftRowsState}
            canDraft={canDraft}
            canPublish={canPublish}
            replanHref={`/platform/billing/catalog?mode=${mode}`}
            {...persistedOutcomeProps}
          />
        }
      />
    </div>
  );
}
