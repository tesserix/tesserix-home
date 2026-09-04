"use client";

import {
  Badge,
  Callout,
  CalloutDescription,
  CalloutTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type StatusType,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// The estate's product-name lookup, reused rather than re-implemented: it
// already renders an id it does not recognise VERBATIM instead of inventing a
// name, which is the property this surface needs. A product federating tenants
// before the console's build knows its id must appear under its raw id, not as
// "Unknown".
import { sourceLabel } from "@/lib/audit";
import { NO_REASON_CODES, type ReasonCodeCatalog } from "@/lib/tenant-lifecycle";
import { splitTenantId, type EstateTenant, type TenantSourceFailure } from "@/lib/tenants";
import { TenantLifecycleAction } from "./tenant-lifecycle-controls";

/**
 * The client half of the tenant directory.
 *
 * A client component for one reason: `FilterBar` takes callbacks a server
 * component cannot supply, and `@tesserix/web`'s barrel is itself
 * `"use client"`. The page stays a server component so the read happens on the
 * server and the filtering stays server-side — the same split as
 * `tickets/queue-view.tsx` and `audit-log/audit-timeline.tsx`.
 */

/**
 * The "this directory is incomplete" banner.
 *
 * Exported so a test can assert it names the source AND the reason, and so the
 * no-failures case can be asserted to render nothing at all — a test that only
 * checks the surface "renders without error" passes just as happily when the
 * failure list is dropped on the floor, which is the bug worth guarding.
 *
 * Why it exists: a directory is read as a census. An operator who cannot find
 * a tenant here concludes it does not exist, so a product quietly missing from
 * the fan-out turns a partial answer into a false negative. Naming the product
 * and the reason is what converts "not in the list" back into "not in the list
 * we could read".
 */
export function IncompleteDirectory({
  failures,
}: {
  failures: readonly TenantSourceFailure[];
}) {
  if (failures.length === 0) return null;
  return (
    <Callout variant="warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This directory is incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        {failures.length === 1
          ? "One product could not be read. Its tenants are missing from the table below."
          : `${failures.length} products could not be read. Their tenants are missing from the table below.`}
      </CalloutDescription>
      <ul className="mt-2 space-y-1 text-sm">
        {failures.map((failure) => (
          <li key={failure.source}>
            <span className="font-medium">{sourceLabel(failure.source)}</span>
            {" — "}
            {failure.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * A badge tone for a status the console does not own.
 *
 * `EstateTenant.status` is the PRODUCT's own word, rendered verbatim — this
 * function only picks a colour for it, and every status it does not recognise
 * gets the neutral one. That asymmetry is deliberate: guessing a colour wrong
 * is a cosmetic mistake, whereas mapping the word itself would replace a
 * product's vocabulary with the console's and quietly rename a state its own
 * team named. Matched case-insensitively because products differ on casing
 * ("ACTIVE", "active") and a case difference is not a different state.
 */
export function tenantStatusTone(status: string): StatusType {
  switch (status.trim().toLowerCase()) {
    case "active":
    case "live":
      return "success";
    case "trial":
    case "pending":
    case "provisioning":
      return "info";
    case "suspended":
    case "past_due":
      return "warning";
    case "cancelled":
    case "canceled":
    case "terminated":
      return "error";
    default:
      // Includes the status this build has never seen. It still renders — with
      // its own text — just without a colour claiming to know what it means.
      return "neutral";
  }
}

/**
 * `created_at` is an untrusted wire field: `parseEstateTenants` type-checks it
 * but never parses it, so a version skew or a truncated value arrives here as
 * a well-typed string that `new Date()` turns into an Invalid Date — and
 * `Intl.DateTimeFormat.format` THROWS `RangeError: Invalid time value` on one,
 * which inside a render is the whole table replaced by an error boundary. The
 * unparseable value falls back to printing itself, which is the honest
 * rendering of "the product sent this". Same guard, same reasoning as
 * `platform/health`'s `formatCheckedAt`.
 */
export function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** The em-dash used wherever a product supplied no value — the same muted
 *  idiom the CRM tables already use, rather than a blank cell that reads as a
 *  rendering fault. */
function Absent() {
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Name plus the product's OWN id beneath it.
 *
 * `EstateTenant.id` is namespaced `<source>:<id>` by the server so two
 * products both returning `1` stay distinguishable in a merged list — but the
 * namespaced form is the console's key, not anything an operator can paste
 * into the product's own admin. `splitTenantId` gives back the id the product
 * would recognise, which is the one worth showing.
 */
function NameCell({ tenant }: { tenant: EstateTenant }) {
  const { productId } = splitTenantId(tenant.id);
  return (
    <div className="flex flex-col">
      <span className="font-medium">{tenant.name}</span>
      <span className="text-muted-foreground font-mono text-xs">{productId}</span>
    </div>
  );
}

export interface TenantDirectoryProps {
  descriptors: FilterDescriptor[];
  /**
   * The filters the server actually applied, not what the URL happens to say.
   * The two differ when a URL carries a product no descriptor offers: the page
   * ignores it when fetching, so the bar must show it as unset too. Reading the
   * URL again here would render a filter that is not in effect.
   */
  values: FilterValues;
  tenants: readonly EstateTenant[];
  /** Products the fan-out could not read, from the response's own `failures`. */
  failures: readonly TenantSourceFailure[];
  /**
   * Each product's lifecycle reason codes, read once per product by the page
   * (contract §8.8) rather than once per row. A product absent here renders
   * its rows' action as the visible gap — never with another product's codes.
   */
  reasonCodes?: ReasonCodeCatalog;
  state: SurfaceState;
  emptyMessage: string;
  /** What the directory does and does not cover. */
  scopeNote: string;
  /** Forwarded to `SurfaceStateView` for the `reauth-required` state — only
   *  the page knows its own path. */
  reauthReturnTo?: string;
}

export function TenantDirectory({
  descriptors,
  values,
  tenants,
  failures,
  reasonCodes = NO_REASON_CODES,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: TenantDirectoryProps) {
  const { set, clear } = useUrlFilters(descriptors);

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        descriptors={descriptors}
        values={values}
        onChange={set}
        onClear={clear}
      />

      {/* The incompleteness banner comes FIRST, above the table. An operator
          who scans a directory and only afterwards learns a product was
          missing has already drawn the conclusion the banner exists to
          prevent. It renders alongside the table, never instead of it: one
          product being unreachable must not hide the tenants the others
          returned. */}
      <IncompleteDirectory failures={failures} />

      {state.kind === "ready" ? (
        <Table aria-label="Tenants">
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Created</TableHead>
            {/* Not "Actions" plural: there is exactly one, and which one it is
                depends on the row's own status. */}
            <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => (
              // The namespaced id, not the product's own: it is the only key
              // guaranteed unique across a merged list, which is the whole
              // reason the server stamps it.
              <TableRow key={tenant.id}>
                <TableCell>
                  <NameCell tenant={tenant} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={tenantStatusTone(tenant.status)} size="sm">
                    {tenant.status}
                  </StatusBadge>
                </TableCell>
                <TableCell>
                  {tenant.ownerEmail ? tenant.ownerEmail : <Absent />}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{sourceLabel(tenant.source)}</Badge>
                </TableCell>
                <TableCell>
                  {tenant.createdAt ? (
                    // The machine-readable value carries the raw string either
                    // way, parseable or not — so a value the formatter refused
                    // is still recoverable from the markup.
                    <time dateTime={tenant.createdAt}>
                      {formatCreated(tenant.createdAt)}
                    </time>
                  ) : (
                    <Absent />
                  )}
                </TableCell>
                {/* Last column, deliberately. Suspending is consequential
                    enough that it should be read after the row, not before
                    it — an operator scanning left to right meets the tenant,
                    its status and its owner before the control that changes
                    them. */}
                <TableCell>
                  <TenantLifecycleAction tenant={tenant} reasonCodes={reasonCodes} />
                  {/* NOT THE ONLY ROW CONTROL THAT EXISTS.
                      `tenant-pricing-override-controls.tsx` is built and
                      tested and deliberately NOT rendered here: it mints a
                      real Stripe coupon that nothing attaches until #660 is
                      called (#331, T3), and this console deploys on merge.
                      Mounting it is T3's step — see that file's header and
                      `.planning/quick/260904-po1-tenant-pricing-override/PLAN.md`.
                      Until then, an override is not reachable from any
                      surface, which is the state the plan asked for. */}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <SurfaceStateView
          state={state}
          emptyMessage={emptyMessage}
          onClearFilters={clear}
          reauthReturnTo={reauthReturnTo}
        />
      )}

      <p className="text-xs text-muted-foreground">{scopeNote}</p>
    </div>
  );
}
