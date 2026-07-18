"use client";

// HomeChef DELIVERY-INTELLIGENCE cost/usage view (#699). Read-only window onto
// what the self-delivery pricing engine costs to run: how many paid routing /
// weather calls it makes, how often the two-tier (Redis hot + CNPG durable)
// cache spares one, the per-tier zone pricing shape, and the estimated spend.
//
// Every metric comes from apps/api GET /admin/delivery/intelligence via the
// signed HomeChef gateway. Zone pricing is edited on the Go side (admin zone
// CRUD); this page is the operator's cost dashboard, refreshing on a poll.

import useSWR from "swr";

import { swrFetcher } from "@/lib/products/homechef/client";
import { formatINR, titleCase } from "@/lib/products/homechef/format";
import type { DeliveryIntelligenceResponse } from "@/lib/products/homechef/contracts";

function usd(n: number | null | undefined): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  // Sub-cent precision matters here — a single call is fractions of a cent.
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function pct(ratio: number | null | undefined): string {
  const v = typeof ratio === "number" && isFinite(ratio) ? ratio : 0;
  return `${(v * 100).toFixed(1)}%`;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export default function HomechefDeliveryIntelligencePage() {
  const { data, isLoading, error } = useSWR<DeliveryIntelligenceResponse>(
    ["/delivery/intelligence", {}],
    swrFetcher,
    { refreshInterval: 30_000 },
  );

  const u = data?.usage;
  const lookups =
    (u?.distanceProviderCalls ?? 0) + (u?.distanceHotHits ?? 0) + (u?.distanceDurableHits ?? 0);

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Delivery intelligence</h1>
        <p className="text-sm text-muted-foreground">
          Self-delivery pricing cost &amp; usage · routing and weather API spend, cache efficiency,
          and per-tier zone pricing
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load delivery intelligence"}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data ? (
        <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No delivery-intelligence data yet.
        </p>
      ) : (
        <>
          {/* REQUESTS */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Requests (since restart)</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Cache hit ratio"
                value={pct(u?.distanceCacheHitRatio)}
                hint={`${lookups.toLocaleString()} distance lookups`}
              />
              <Stat
                label="Paid routing calls"
                value={(u?.distanceProviderCalls ?? 0).toLocaleString()}
                hint="cache misses — the only ones billed"
              />
              <Stat
                label="Cache hits (free)"
                value={((u?.distanceHotHits ?? 0) + (u?.distanceDurableHits ?? 0)).toLocaleString()}
                hint={`${(u?.distanceHotHits ?? 0).toLocaleString()} Redis · ${(u?.distanceDurableHits ?? 0).toLocaleString()} CNPG`}
              />
              <Stat
                label="Weather calls"
                value={(u?.weatherProviderCalls ?? 0).toLocaleString()}
                hint="uncached by design (live signal)"
              />
              <Stat
                label="Fuel-index calls"
                value={(u?.fuelProviderCalls ?? 0).toLocaleString()}
                hint="cached daily — rare"
              />
              <Stat
                label="Traffic calls"
                value={(u?.trafficProviderCalls ?? 0).toLocaleString()}
                hint="live signal, ~5 min cache"
              />
            </div>
          </section>

          {/* EXPENSES */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Expenses</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Spend since restart"
                value={usd(u?.estimatedSpendUsd)}
                hint="routing + weather"
              />
              <Stat
                label="All-time distance spend"
                value={usd(data.allTimeDistanceSpendUsd)}
                hint={`${data.cachedTrips.toLocaleString()} trips paid once, ever`}
              />
              <Stat
                label="Routing price / call"
                value={usd(u?.distancePricePerCall)}
                hint="configurable"
              />
              <Stat
                label="Weather price / call"
                value={usd(u?.weatherPricePerCall)}
                hint="configurable"
              />
            </div>
          </section>

          {/* TIER */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              Zone pricing by tier{" "}
              <span className="text-muted-foreground">({data.zoneTiers.length})</span>
            </h2>
            {data.zoneTiers.length === 0 ? (
              <p className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
                No delivery zones configured yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Tier</th>
                      <th className="px-4 py-3">Zones</th>
                      <th className="px-4 py-3">Active</th>
                      <th className="px-4 py-3">Avg base fare</th>
                      <th className="px-4 py-3">Avg / km</th>
                      <th className="px-4 py-3">Avg minimum</th>
                      <th className="px-4 py-3">Avg surge</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.zoneTiers.map((t) => (
                      <tr key={t.tier} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">{titleCase(t.tier)}</td>
                        <td className="px-4 py-3 tabular-nums">{t.count}</td>
                        <td className="px-4 py-3 tabular-nums">{t.activeZoneCount}</td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(t.avgBaseFare)}</td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(t.avgPerKmRate)}</td>
                        <td className="px-4 py-3 tabular-nums">{formatINR(t.avgMinimumFare)}</td>
                        <td className="px-4 py-3 tabular-nums">{t.avgSurgeMultiplier.toFixed(2)}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-muted-foreground">
            Live counters reset on API restart. All-time distance spend is derived from the durable
            distance cache (one row = one chef→address trip paid for exactly once). Auto-refreshes
            every 30s.
          </p>
        </>
      )}
    </div>
  );
}
