"use client";

// E2 — Notification log.
//
// Reads from tesserix_admin.email_events (populated by the SendGrid
// webhook receiver, see Wave 1.5). Until the operator finishes the
// SendGrid Event Webhook config + signing key step, this page renders
// the empty state.
//
// Two queries: aggregate (KPIs over a window) + recent (raw event list).
// Both auto-refresh every 30s while the page is open.

import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

interface EventRow {
  id: number;
  sgEventId: string;
  eventType: string;
  product: string | null;
  tenantId: string | null;
  templateKey: string | null;
  recipient: string | null;
  reason: string | null;
  eventAt: string;
}

interface MetricsRow {
  product: string;
  tenantId: string | null;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  bounces: number;
  drops: number;
  unsubscribes: number;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const EVENT_TONE: Record<string, string> = {
  processed: "bg-muted text-muted-foreground",
  delivered: "bg-emerald-50 text-emerald-700",
  open: "bg-sky-50 text-sky-700",
  click: "bg-violet-50 text-violet-700",
  bounce: "bg-rose-50 text-rose-700",
  dropped: "bg-rose-50 text-rose-700",
  spamreport: "bg-rose-50 text-rose-700",
  unsubscribe: "bg-amber-50 text-amber-700",
  group_unsubscribe: "bg-amber-50 text-amber-700",
  group_resubscribe: "bg-emerald-50 text-emerald-700",
  deferred: "bg-amber-50 text-amber-700",
};

const PRODUCT_OPTIONS = [
  { value: "", label: "All products" },
  { value: "mark8ly", label: "Mark8ly" },
];

const DAYS_OPTIONS = [
  { value: 1, label: "24h" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
];

export default function NotificationLogPage() {
  const [product, setProduct] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [days, setDays] = useState(7);

  const params = new URLSearchParams();
  if (product) params.set("product", product);
  if (tenantId) params.set("tenant_id", tenantId);
  params.set("days", String(days));

  const metricsKey = `/api/admin/email-events?view=metrics&${params.toString()}`;
  const recentKey = `/api/admin/email-events?view=recent&${params.toString()}&limit=100`;

  const metrics = useSWR<{ days: number; rows: MetricsRow[] }>(metricsKey, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });
  const recent = useSWR<{ events: EventRow[] }>(recentKey, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });

  const totals = (metrics.data?.rows ?? []).reduce(
    (acc, r) => ({
      sent: acc.sent + r.sent,
      delivered: acc.delivered + r.delivered,
      opens: acc.opens + r.opens,
      clicks: acc.clicks + r.clicks,
      bounces: acc.bounces + r.bounces,
      drops: acc.drops + r.drops,
      unsubscribes: acc.unsubscribes + r.unsubscribes,
    }),
    { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, drops: 0, unsubscribes: 0 },
  );

  const events = recent.data?.events ?? [];
  const hasError = metrics.error || recent.error;
  const isLoading = metrics.isLoading || recent.isLoading;

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Notification log"
        description="Engagement events from the SendGrid webhook (delivered / open / click / bounce / drop). Auto-refreshes every 30s."
      />
      <div className="flex-1 space-y-6 p-6">
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
          <FilterField label="Product">
            <select
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {PRODUCT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Tenant ID">
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="optional"
              className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
            />
          </FilterField>

          <FilterField label="Window">
            <div className="flex gap-1 rounded-lg border border-border bg-background p-0.5">
              {DAYS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setDays(o.value)}
                  aria-pressed={days === o.value}
                  className={
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors " +
                    (days === o.value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/50")
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </FilterField>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          <KpiTile label="Sent" value={String(totals.sent)} loading={isLoading} />
          <KpiTile
            label="Delivered"
            value={String(totals.delivered)}
            hint={
              totals.sent > 0
                ? `${Math.round((totals.delivered / totals.sent) * 100)}%`
                : undefined
            }
            loading={isLoading}
          />
          <KpiTile
            label="Opens"
            value={String(totals.opens)}
            hint={
              totals.delivered > 0
                ? `${Math.round((totals.opens / totals.delivered) * 100)}%`
                : undefined
            }
            loading={isLoading}
          />
          <KpiTile
            label="Clicks"
            value={String(totals.clicks)}
            loading={isLoading}
          />
          <KpiTile
            label="Bounces"
            value={String(totals.bounces + totals.drops)}
            hint="bounce + dropped"
            loading={isLoading}
          />
          <KpiTile
            label="Unsubscribes"
            value={String(totals.unsubscribes)}
            loading={isLoading}
          />
        </div>

        {hasError && (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <p className="font-medium">Could not load email events.</p>
            <p className="text-xs text-muted-foreground">
              If this is a fresh deploy, the{" "}
              <code className="rounded bg-muted px-1">email_events</code> migration
              may not have run yet, or the SendGrid Event Webhook hasn&rsquo;t been
              configured to point at <code>https://tesserix.app/webhooks/sendgrid</code>{" "}
              with a signing key in GSM. See the operator activation checklist in{" "}
              <code className="rounded bg-muted px-1">.planning/HANDOFF.md</code>.
            </p>
          </div>
        )}

        {!isLoading && !hasError && events.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">No events in this window</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Either nothing was sent, or the SendGrid webhook hasn&rsquo;t started
              posting events to <code>/webhooks/sendgrid</code> yet. Configure the
              webhook + signing key (operator step) and the table will populate
              within seconds of the next send.
            </p>
          </div>
        )}

        {events.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Template</th>
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                      <span title={e.eventAt}>
                        {new Date(e.eventAt).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          EVENT_TONE[e.eventType] ?? "bg-muted text-muted-foreground"
                        }`}
                      >
                        {e.eventType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{e.product ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {e.tenantId ? shortId(e.tenantId) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {e.templateKey ?? "—"}
                    </td>
                    <td className="max-w-[16rem] px-4 py-3 text-xs">
                      <span className="block truncate" title={e.recipient ?? ""}>
                        {e.recipient ?? "—"}
                      </span>
                    </td>
                    <td
                      className="max-w-[20rem] px-4 py-3 text-xs text-muted-foreground"
                      title={e.reason ?? undefined}
                    >
                      <span className="block truncate">{e.reason ?? "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}
