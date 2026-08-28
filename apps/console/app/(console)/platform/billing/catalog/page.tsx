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
import { dbReadError } from "@/lib/db-read-error";
import { requiresCapability } from "@/lib/internal-access";
import { PlatformApiError } from "@/lib/platform-api";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readCatalogRows,
  readLatestRuns,
  readLivePublication,
  readRevisionRows,
  readWindowStatus,
  type CatalogRow,
  type LivePublication,
  type ModeLatestRun,
  type ParityWindowStatus,
} from "@/lib/db/plan-catalog-repo";
// A VALUE import, not `import type` — `currentDraft` runs HERE, server-side,
// same as every other read on this page. `publish-repo.ts` carries its own
// `server-only`; see that module's header for why a client component
// reaching it is exactly the mistake this page's own comments warn every
// client sibling (`catalog-views.tsx`, `authoring-panel.tsx`) away from.
import { currentDraft } from "@/lib/db/publish-repo";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { CatalogViews } from "./catalog-views";
import { AuthoringPanel } from "./authoring-panel";

/**
 * The plan catalog's console surface — tesserix-home#326's read-only half
 * ("read-only console surface behind the `billing` capability") plus, as of
 * task 9 (tesserix-home#396), the authoring surface `AuthoringPanel` mounts
 * beside it.
 *
 * # This page itself still imports nothing from Stripe
 *
 * That claim now needs to be precise about WHO it covers: this file's own
 * five reads (below) touch only `tesserix-postgres`, never Stripe, and never
 * publish anything — the fifth (`readDraft`) reads only whether a draft
 * exists, not Stripe. `AuthoringPanel` and its children are a different
 * story on purpose: `DraftEditor`, `PublishView` and `PublishOutcome` are
 * CLIENT components whose server actions (`actions.ts`) are the write path
 * — Stripe reads, Stripe writes, the guards, the operation log — with their
 * own capability checks (`checkOperatorCapability`) independent of anything
 * this page decides. This page reads the catalog and hands `AuthoringPanel`
 * what it needs to decide what its OWN controls may do; it does not do any
 * of that deciding itself.
 *
 * # FIVE independent reads, not one
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
 * the same failure twice. Six functions, not one, so the log line and the
 * migrations-pending copy each name the table that actually failed rather
 * than a generic "the plan catalog" that leaves an operator guessing which of
 * six reads broke.
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

async function readRuns(): Promise<ModeLatestRun[]> {
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
 * reacts to, so a broken draft-rows read cannot take this read (or the four
 * above it) down with it. See the module doc comment's "FIVE independent
 * reads" section.
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
 * Called OUTSIDE the five-way `Promise.allSettled` below, on purpose: it
 * depends on `readDraft`'s own result (there is no id to read rows for until
 * that read resolves), so it cannot be a sibling in the same array — but it
 * is still independently `allSettled`, in its own `try`/`catch`, so its
 * failure narrows into `draftRowsState` alone and never touches
 * `catalogState`, `windowState`, `runsState`, `publicationState` or even
 * `draftState` (which already succeeded by the time this runs).
 */
async function readDraftRows(revisionId: string): Promise<CatalogRow[]> {
  if (!isDatabaseConfigured()) notConfigured();
  return readRevisionRows(revisionId, SINGLE_SOURCE);
}

export default async function PlanCatalog({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}) {
  const mode = readCatalogMode(await searchParams);

  // `allSettled`, not `all`: see the module doc comment above.
  const [windowResult, catalogResult, runsResult, publicationResult, draftResult] =
    await Promise.allSettled([
      readWindow(),
      readCatalog(mode),
      readRuns(),
      readPublication(mode),
      readDraft(),
    ]);

  const window = windowResult.status === "fulfilled" ? windowResult.value : null;
  const windowState: SurfaceState = resolveState({
    isLoading: false,
    error: windowResult.status === "rejected" ? windowReadError(windowResult.reason) : null,
    // `window?.modes` is always length 2 when the read succeeds — see
    // `readWindowStatus`'s "both modes, always" guarantee — so this can only
    // resolve to `ready` or the error/unavailable states, never `empty`.
    rows: window?.modes ?? [],
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
    // Same "both modes, always" guarantee as `window` above — `runs` is
    // length 2 whenever the read succeeds, even on a database with zero rows
    // in `plan_catalog_parity_runs`. That "no runs recorded yet" case is a
    // `run: null` entry inside a `ready` state, not an `empty` surface state;
    // `CatalogViews` renders it explicitly.
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
  const session = await getCurrentSession();
  const canDraft = !requiresCapability() || hasCapability(session?.roles, "billing");
  const canPublish = canDraft && hasCapability(session?.roles, "publish-catalog");

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Plan catalog"
        description="The published Stripe catalog and the nightly parity check that watches it, per mode."
      />

      <CatalogViews
        mode={mode}
        windowDays={OBSERVATION_WINDOW_DAYS}
        windowStatus={window}
        windowState={windowState}
        catalog={catalog}
        catalogState={catalogState}
        runs={runs}
        runsState={runsState}
        publication={publication}
        publicationState={publicationState}
      />

      <AuthoringPanel
        mode={mode}
        catalog={catalog}
        draftState={draftState}
        draftId={draft?.id ?? null}
        draftRows={draftRows}
        draftRowsState={draftRowsState}
        canDraft={canDraft}
        canPublish={canPublish}
        replanHref={`/platform/billing/catalog?mode=${mode}`}
      />
    </div>
  );
}
