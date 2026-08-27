"use client";

import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import { consolePath } from "@tesserix/console-core";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import { sourceLabel } from "@/lib/audit";
// `formatMoney` from `lib/money`, NOT `lib/billing`: the latter imports
// PlatformApiError from platform-api, which reaches pg and node:crypto. A
// value import from there fails `next build` while tsc and jsdom both pass.
import { formatMoney } from "@/lib/money";
import type {
  BillingSourceFailure,
  SubscriptionPage,
  TrialPage,
} from "@/lib/billing";

/**
 * The client half of the estate billing surface.
 *
 * Two tabs on ONE route rather than two routes: #133 settled that a second
 * door onto one capability is worse than one door, because an operator then
 * has to know which door records the answer. Subscriptions and trials are two
 * views of §8.2, not two capabilities.
 */

/**
 * The one door onto tesserix-home#326's plan catalog surface.
 *
 * A client component rather than a plain `<a>` in `page.tsx`: `page.tsx` is a
 * server component, and `@tesserix/web`'s `Button` is a value export off a
 * `"use client"` barrel — importing it there resolves to `undefined` at
 * render, the same trap `page-header.tsx`'s comment documents. `BillingViews`
 * is already `"use client"`, so this lives here and `page.tsx` renders it as
 * a header action instead.
 */
export function CatalogLink() {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={consolePath("platform.billingCatalog")}>View plan catalog</Link>
    </Button>
  );
}

/** A trial with no payment method is the row somebody acts on. */
export function trialTone(paymentMethodOnFile: boolean): "warning" | "neutral" {
  return paymentMethodOnFile ? "neutral" : "warning";
}

/** Days remaining, phrased so 0 and 1 do not read as bugs. */
export function daysLabel(days: number): string {
  if (days < 0) return "ended";
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/**
 * One or more products could not be read.
 *
 * Rendered above the table and never instead of it. On a revenue surface the
 * stakes are specific: a short list reads as a small book of business, and a
 * product dropping out of the fan-out turns that into an understatement nobody
 * can see. The total is affected too — a failed product contributes nothing
 * rather than zero — so the callout says so rather than leaving it inferred.
 */
export function IncompleteBilling({ failures }: { failures: readonly BillingSourceFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <Callout variant="warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This view is incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        {failures.length === 1
          ? "One product could not be read. Its rows are missing and the total understates the estate."
          : `${failures.length} products could not be read. Their rows are missing and the total understates the estate.`}
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

function Counted({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {total === shown ? `${total} ${noun}.` : `Showing ${shown} of ${total} ${noun}.`}{" "}
      Amounts are each product&apos;s own currency, shown unchanged.
    </p>
  );
}

export interface BillingViewsProps {
  subscriptions: SubscriptionPage;
  trials: TrialPage;
  subscriptionsState: SurfaceState;
  trialsState: SurfaceState;
  reauthReturnTo: string;
}

export function BillingViews({
  subscriptions,
  trials,
  subscriptionsState,
  trialsState,
  reauthReturnTo,
}: BillingViewsProps) {
  return (
    <SurfaceTabs
      label="Billing views"
      tabs={[
        {
          // Trials FIRST: it is the work queue. Subscriptions is a state view
          // an operator consults; a trial ending without a payment method is
          // something they do today.
          id: "trials",
          label: "Trials",
          content: (
            <div className="flex flex-col gap-4">
              <IncompleteBilling failures={trials.failures} />
              {trialsState.kind === "ready" ? (
                <>
                  <Table aria-label="Expiring trials">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ends</TableHead>
                        <TableHead>Tenant</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Payment method</TableHead>
                        <TableHead>Product</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {trials.data.map((row) => (
                        <TableRow key={`${row.source}:${row.tenantId}:${row.storeId ?? ""}`}>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            <time dateTime={row.trialEndsAt}>{daysLabel(row.daysRemaining)}</time>
                          </TableCell>
                          <TableCell className="font-medium">
                            {row.tenantName ?? row.tenantId}
                          </TableCell>
                          <TableCell>
                            {row.plan}
                            {row.amount ? (
                              <span className="ml-1 text-muted-foreground">
                                {formatMoney(row.amount)}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant={trialTone(row.paymentMethodOnFile)}>
                              {row.paymentMethodOnFile ? "on file" : "none"}
                            </Badge>
                          </TableCell>
                          <TableCell>{sourceLabel(row.source)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Counted shown={trials.data.length} total={trials.total} noun="trials" />
                </>
              ) : (
                <SurfaceStateView
                  state={trialsState}
                  emptyMessage="No trials are expiring. Every product that answered has none."
                  reauthReturnTo={reauthReturnTo}
                />
              )}
            </div>
          ),
        },
        {
          id: "subscriptions",
          label: "Subscriptions",
          content: (
            <div className="flex flex-col gap-4">
              <IncompleteBilling failures={subscriptions.failures} />
              {subscriptionsState.kind === "ready" ? (
                <>
                  <Table aria-label="Subscriptions">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Renews</TableHead>
                        <TableHead>Tenant</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Product</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {subscriptions.data.map((row) => (
                        <TableRow key={`${row.source}:${row.tenantId}:${row.storeId ?? ""}`}>
                          <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                            {row.currentPeriodEnd ? row.currentPeriodEnd.slice(0, 10) : "—"}
                          </TableCell>
                          <TableCell className="font-medium">
                            {row.tenantName ?? row.tenantId}
                          </TableCell>
                          <TableCell>{row.plan}</TableCell>
                          {/* An absent amount renders as an em dash, never 0:
                              "no resolvable price" and "pays nothing" are
                              different claims and only one is true. */}
                          <TableCell className="tabular-nums">{formatMoney(row.amount)}</TableCell>
                          <TableCell>
                            {/* The product's own word for it, rendered
                                verbatim — the console does not translate one
                                product's vocabulary into another's. */}
                            <Badge variant="neutral">{row.status}</Badge>
                            {row.cancelAtPeriodEnd ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                cancels at period end
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>{sourceLabel(row.source)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Counted
                    shown={subscriptions.data.length}
                    total={subscriptions.total}
                    noun="subscriptions"
                  />
                </>
              ) : (
                <SurfaceStateView
                  state={subscriptionsState}
                  emptyMessage="No subscriptions. Every product that answered has none."
                  reauthReturnTo={reauthReturnTo}
                />
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
