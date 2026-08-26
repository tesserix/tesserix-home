import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — it 500'd the dashboard once.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchEstateTenants, fetchLifecycleReasonCodes } from "@/lib/platform-api";
import type { ReasonCodeCatalog } from "@/lib/tenant-lifecycle";
import { splitTenantId, type EstateTenant, type TenantSourceFailure } from "@/lib/tenants";
import { TenantDirectory } from "./tenant-directory";

/**
 * The estate's tenant directory — every federating product's tenants in one
 * list, with the products that could not be read named beside them.
 *
 * ONE read, unlike the audit timeline's two: `GET /v1/tenants` fans out to
 * every product in `FEDERATION_PRODUCTS` behind the platform API and returns a
 * partial result plus a per-source `failures` list. The console never talks to
 * a product directly, and it deliberately has no apps/web fallback —
 * `fetchEstateTenants` explains why at length (apps/web's `/admin/tenants`
 * WRITES mark8ly's table over the cross-database grant, so falling back to it
 * would not be a rollback).
 *
 * The property this surface exists to hold: **a partial estate says so.** A
 * directory is read as a census — an operator scanning it concludes that a
 * tenant they cannot find does not exist. A product silently dropping out of
 * the fan-out turns that into a false negative, which is why `failures` is
 * rendered above the table rather than logged, and why zero rows WITH failures
 * must never read as "there are no tenants". Only `parseEstateTenants` can
 * make `failures` reliable (it refuses a body without the field rather than
 * defaulting it to `[]`); this page's job is to put it on screen.
 */

/** Copy for the `empty` state — no rows AND nothing lost. Exported so the test
 *  asserts the shipped string rather than a second copy that could drift. */
export const DIRECTORY_EMPTY_MESSAGE =
  "No tenants. Every product that answered has none.";

/**
 * The `empty` copy when rows are zero but a source was lost.
 *
 * `empty` is still the right state — there is genuinely nothing to tabulate —
 * but the DEFAULT copy would assert a census the surface cannot back. "No
 * tenants" and "no tenants that we could read" are different claims, and only
 * the second is true here. The failure callout above the table names which
 * products were lost; this sentence is what stops the empty state from
 * contradicting it.
 */
export function emptyMessageFor(failures: readonly TenantSourceFailure[]): string {
  if (failures.length === 0) return DIRECTORY_EMPTY_MESSAGE;
  return (
    "No tenants were read — and " +
    (failures.length === 1
      ? "one product could not be read at all"
      : `${failures.length} products could not be read at all`) +
    ", so this is not evidence that there are none."
  );
}

/**
 * The honest limit of what is on screen, rendered under the table.
 *
 * The platform API asks each product for a bounded page, so a product with
 * more tenants than that bound is shown in part. Saying so costs a line; not
 * saying so lets an operator read "not in this list" as "not a tenant", which
 * is exactly the conclusion a directory invites and the one it cannot support.
 * No number is quoted because the bound is `platform-api.ts`'s to choose and a
 * transcribed constant here would be the copy that goes stale.
 */
export const DIRECTORY_SCOPE_NOTE =
  "Each product is asked for a bounded page of tenants, so a product with many " +
  "tenants may not be listed in full. Status is each product's own word for it, " +
  "shown unchanged — the console does not translate one product's vocabulary " +
  "into another's.";

/**
 * Copy for the 501, which is NOT an error and must not read as one.
 *
 * A 501 here has two causes and neither is a fault: `PLATFORM_API_ORIGIN` is
 * unset (`fetchEstateTenants` raises its own), or the API is configured with
 * no federating product. Both mean the surface is not switched on. The kit's
 * default 501 copy points at `docs/observability-park.md`, which is the right
 * remedy for a parked metrics plane and the wrong one here — it would send an
 * operator to read about instrumentation when the answer is a config value.
 */
export const DIRECTORY_UNAVAILABLE_TITLE = "The tenant directory is not switched on";
export const DIRECTORY_UNAVAILABLE_MESSAGE =
  "No product is federating tenants to the console yet. Nothing is broken and " +
  "there is nothing to retry — this surface turns on when the platform API is " +
  "configured with at least one tenant source.";

/**
 * The filters this surface offers.
 *
 * Product options come from `ESTATE` rather than from the rows on screen, for
 * the reason the ticket queue gives: options derived from the current page can
 * only offer products that already have a tenant here, so the one question an
 * operator reaches for — "does Fe3dr have any?" — is the one that would be
 * missing. `FilterBar` renders its own "All products" entry for the unset
 * value, so there is no explicit `all` option here; a second one would put two
 * indistinguishable "all"s in the same menu. `fetchEstateTenants` treats the
 * absent filter and the literal `all` identically, so the two agree.
 *
 * The trap worth naming: `ESTATE` is the console's list, `FEDERATION_PRODUCTS`
 * is the API's, and they need not match. Asking for a product the API does not
 * federate is refused with a 400 rather than answered with zero rows — which
 * is the behaviour that makes the mismatch visible instead of silent, and is
 * why offering the whole estate is safe.
 *
 * Status is a SEARCH box, not a select, and that is the honest shape. Status
 * is each product's own vocabulary — `EstateTenant.status` is deliberately not
 * narrowed to a union — so a select would have to enumerate it, and a
 * console-side enumeration is a second vocabulary that drifts from the first.
 * Deriving the options from the rows on screen is worse in a different
 * direction: the list would only ever contain statuses that survived the
 * current filter, so a status could disappear from the menu the moment it
 * matched nothing.
 */
export const TENANT_FILTERS: FilterDescriptor[] = [
  {
    key: "product",
    label: "Product",
    type: "select",
    options: ESTATE.map((product) => ({
      value: product.context,
      label: product.name,
    })),
  },
  { key: "q", label: "Search tenants", type: "search" },
  { key: "status", label: "Status", type: "search" },
];

export interface TenantFilters {
  product?: string;
  q?: string;
  status?: string;
}

export type TenantSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input. `product` is only honoured when it names
 * a product this surface actually offers: an unrecognised value forwarded
 * upstream comes back a 400, and the operator would see a red failure caused
 * by their own bookmark. `q` and `status` are free text by design (see
 * `TENANT_FILTERS`) so there is nothing to validate them against — they are
 * trimmed, and a blank one is dropped rather than sent, because the API
 * refuses parameters it does not read and an empty `status=` would filter on
 * the empty string rather than mean "any".
 *
 * Repeated params arrive as an array and are ignored: the endpoint takes one
 * value per key, so honouring the first would apply a filter the bar cannot
 * display.
 */
export function readTenantFilters(searchParams: TenantSearchParams): TenantFilters {
  const filters: TenantFilters = {};

  const product = searchParams.product;
  if (typeof product === "string" && ESTATE.some((p) => p.context === product)) {
    filters.product = product;
  }

  const q = searchParams.q;
  if (typeof q === "string" && q.trim() !== "") filters.q = q.trim();

  const status = searchParams.status;
  if (typeof status === "string" && status.trim() !== "") filters.status = status.trim();

  return filters;
}

/** The applied filters as the bar's display values — what the server actually
 *  used, never what the URL happens to say. See `TenantDirectory`'s `values`. */
export function toFilterValues(filters: TenantFilters): FilterValues {
  const values: FilterValues = {};
  if (filters.product) values.product = filters.product;
  if (filters.q) values.q = filters.q;
  if (filters.status) values.status = filters.status;
  return values;
}

/**
 * Narrow the read's rejection, attaching this surface's own 501 copy.
 *
 * The status is what carries the meaning — `resolveState` maps 501 to
 * `instrumentation-unavailable` and everything else to `error` — but the
 * default copy for that state is about a parked observability plane, which is
 * not what a 501 means here. The override is opt-in precisely so `message`
 * (an internal string: "tenants: PLATFORM_API_ORIGIN is not set…") never
 * reaches the page.
 */
export function tenantReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: {
      title: DIRECTORY_UNAVAILABLE_TITLE,
      message: DIRECTORY_UNAVAILABLE_MESSAGE,
    },
  };
}

export interface DirectoryStateInput {
  /** Whatever `fetchEstateTenants` rejected with, or null. */
  readonly error: unknown;
  readonly rows: readonly EstateTenant[];
  /** True when any filter is narrowing the directory. */
  readonly filtered: boolean;
}

/**
 * Which state the directory is in.
 *
 * The same rule the audit timeline states: **any rows at all means the rows
 * render.** A partial answer is a 200 carrying `failures`, so it arrives here
 * with `error: null` and resolves to `ready` — the lost products are reported
 * beside the table by `failures`, never instead of it. A whole read that threw
 * is the only thing that replaces the table, because in that case there is no
 * table to show.
 *
 * Zero rows plus failures still resolves to `empty`; `emptyMessageFor` is what
 * keeps that state from claiming a census it cannot back.
 */
export function directoryState(input: DirectoryStateInput): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window — Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error: tenantReadError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

/**
 * The operator's exact URL as a relative path — every query param the browser
 * had, not only the three this surface reads — so signing in again returns
 * them exactly where they were. Same shape `middleware.ts`'s `unauthorized`
 * builds, and for the same reason: only the page knows its own path.
 */
export function currentPath(searchParams: TenantSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  const query = params.toString();
  return query ? `/platform/tenants?${query}` : "/platform/tenants";
}

/**
 * Every product that actually has a row on screen.
 *
 * Derived from the ROWS rather than from `ESTATE`, and that is the cheaper
 * direction as well as the honest one: a product with no tenants here needs no
 * vocabulary, and asking for one would spend a federated round trip per
 * configured product on every render of a page that might list two.
 *
 * The source comes out of the namespaced id — the same id the write is aimed
 * at — so the codes offered and the product asked to apply them cannot
 * disagree.
 */
export function productsOnScreen(tenants: readonly EstateTenant[]): string[] {
  const sources = new Set<string>();
  for (const tenant of tenants) sources.add(splitTenantId(tenant.id).source);
  return [...sources].sort();
}

/**
 * Read each product's lifecycle vocabulary, tolerating a product that fails.
 *
 * **Per product, and a failure is dropped rather than thrown.** One product
 * being unreachable must not take out the directory — the page's whole
 * argument is that a partial estate says so rather than rendering nothing —
 * and a product missing from the returned catalog is exactly what the row's
 * action renders as its visible gap. So the failure mode is a disabled button
 * with a sentence beside it, not an error page and not a menu of another
 * product's codes.
 *
 * Not logged here: `platformRequest` already logs the cause with the product,
 * and a second line would double-report one failure.
 */
export async function fetchReasonCodeCatalog(
  products: readonly string[],
): Promise<ReasonCodeCatalog> {
  const entries = await Promise.all(
    products.map(async (product) => {
      try {
        return [product, await fetchLifecycleReasonCodes(product)] as const;
      } catch {
        return null;
      }
    }),
  );

  const catalog: Record<string, Awaited<ReturnType<typeof fetchLifecycleReasonCodes>>> = {};
  for (const entry of entries) {
    if (entry !== null) catalog[entry[0]] = entry[1];
  }
  return catalog;
}

export default async function EstateTenantDirectory({
  searchParams,
}: {
  searchParams: Promise<TenantSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = readTenantFilters(resolvedSearchParams);
  const filtered = Object.keys(filters).length > 0;

  // Caught rather than allowed to reject: a 501 and a genuine failure are both
  // states this page renders, and an uncaught rejection would render the route
  // error boundary instead — replacing "the directory is not switched on" with
  // a stack trace's worth of nothing.
  let tenants: readonly EstateTenant[] = [];
  let failures: readonly TenantSourceFailure[] = [];
  let error: unknown = null;
  try {
    const result = await fetchEstateTenants(filters);
    tenants = result.tenants;
    failures = result.failures;
  } catch (caught: unknown) {
    error = caught;
  }

  // After the rows, because which products to ask depends on which are on
  // screen. Sequential rather than parallel with the read for that reason, and
  // it costs nothing when the read failed: there are no rows, so no products.
  const reasonCodes = await fetchReasonCodeCatalog(productsOnScreen(tenants));

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Tenants"
        description="Every federating product's tenants, in one directory."
      />

      <TenantDirectory
        descriptors={TENANT_FILTERS}
        values={toFilterValues(filters)}
        tenants={tenants}
        failures={failures}
        reasonCodes={reasonCodes}
        state={directoryState({ error, rows: tenants, filtered })}
        emptyMessage={emptyMessageFor(failures)}
        scopeNote={DIRECTORY_SCOPE_NOTE}
        reauthReturnTo={currentPath(resolvedSearchParams)}
      />
    </div>
  );
}
