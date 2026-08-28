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
import { PlatformApiError } from "@/lib/platform-api";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readCatalogRows,
  readLatestRuns,
  readLivePublicationAttribution,
  readWindowStatus,
  type CatalogRow,
  type LivePublicationAttribution,
  type ModeLatestRun,
  type ParityWindowStatus,
} from "@/lib/db/plan-catalog-repo";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { CatalogViews } from "./catalog-views";

/**
 * The plan catalog's read-only console surface — tesserix-home#326's last
 * unchecked box: "read-only console surface behind the `billing`
 * capability".
 *
 * # No write path here, by construction
 *
 * This page imports nothing from Stripe and nothing that can publish a
 * revision. It reads three things, each already built and already running in
 * production: the 7-day parity observation window (#327's gate), the
 * published catalog for one Stripe mode, and the latest parity run per mode.
 * Editing, publishing, and "run the check now" belong to a separate authoring
 * surface with its own guards and its own operation log — see the task that
 * built this page for why that surface is explicitly out of scope here.
 *
 * # FOUR independent reads, not one
 *
 * Same discipline `../page.tsx` (estate billing) and `../../audit-log/page.tsx`
 * apply: `Promise.allSettled`, not `Promise.all`, so a failure in one read
 * (say, the parity-runs table) cannot blank the catalog table that read
 * cleanly. An operator deciding whether #327's revocation is safe needs the
 * catalog to render even on a day the runs table is having a bad time, and
 * vice versa. The fourth read — task 2R — is who published the mode's
 * currently-live revision and when; the same rule applies to it: a failed
 * publication read must not take down the catalog table or the observation
 * window.
 *
 * # Reads tesserix-postgres directly, like `audit-log`, unlike `billing`
 *
 * The estate billing page federates through `platform-api`, whose 403/501
 * contract `billingReadError` narrows. This page's three reads are the
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
 * the same failure twice. Four functions, not one, so the log line and the
 * migrations-pending copy each name the table that actually failed rather
 * than a generic "the plan catalog" that leaves an operator guessing which of
 * four reads broke.
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

async function readPublication(mode: StripeMode): Promise<LivePublicationAttribution | null> {
  if (!isDatabaseConfigured()) notConfigured();
  // `null` is the normal answer for a mode that has never been published —
  // `live` before #0037, and any future second source or mode before its
  // first publish. It is not a failure and must not be treated like one.
  return readLivePublicationAttribution(mode);
}

export default async function PlanCatalog({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}) {
  const mode = readCatalogMode(await searchParams);

  // `allSettled`, not `all`: see the module doc comment above.
  const [windowResult, catalogResult, runsResult, publicationResult] = await Promise.allSettled([
    readWindow(),
    readCatalog(mode),
    readRuns(),
    readPublication(mode),
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
    </div>
  );
}
