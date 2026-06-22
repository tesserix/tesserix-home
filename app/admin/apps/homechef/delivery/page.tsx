"use client";

// Fe3dr 3PL delivery admin (Wave 7E): provider list + enable/disable +
// cost reconciliation (provider cost vs collected delivery fee). Provider key
// config + "test connection" live in homechef-api's provider CRUD, not here.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";
import { formatCurrency, formatNumber } from "@/components/admin/metrics/format";
import { useConfirm } from "@/components/admin/confirm-dialog";

interface ProviderRow {
  id: string;
  name: string;
  code: string;
  is_enabled: boolean;
  is_active: boolean;
  priority: number;
  base_cost: number;
  currency: string;
  total_deliveries: number;
  success_rate: number;
  last_used_at: string | null;
}

interface Reconciliation {
  total_3pl_deliveries: number;
  provider_cost: number;
  collected_fee: number;
  margin: number;
}

export default function HomechefDeliveryPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, rRes] = await Promise.all([
        fetch("/api/admin/apps/homechef/delivery/providers", { credentials: "include" }),
        fetch("/api/admin/apps/homechef/delivery/reconciliation", { credentials: "include" }),
      ]);
      if (!pRes.ok) throw new Error(`providers HTTP ${pRes.status}`);
      if (!rRes.ok) throw new Error(`reconciliation HTTP ${rRes.status}`);
      setProviders(((await pRes.json()) as { data: ProviderRow[] }).data);
      setRecon(((await rRes.json()) as { data: Reconciliation }).data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(p: ProviderRow) {
    const ok = await confirm({
      title: p.is_enabled ? "Disable provider" : "Enable provider",
      message: `${p.is_enabled ? "Disable" : "Enable"} ${p.name} for new deliveries?`,
      confirmLabel: p.is_enabled ? "Disable" : "Enable",
      tone: p.is_enabled ? "destructive" : "default",
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      const res = await fetch(`/api/admin/apps/homechef/delivery/providers/${p.id}/toggle`, {
        method: "PUT", credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      window.alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Fe3dr · Delivery (3PL)" />
      <div className="flex-1 space-y-4 p-6">
        {/* Reconciliation */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiTile label="3PL deliveries" value={recon ? formatNumber(recon.total_3pl_deliveries) : "—"} loading={loading} />
          <KpiTile label="Provider cost" value={recon ? formatCurrency(recon.provider_cost, "INR") : "—"} hint="what Fe3dr pays 3PLs" loading={loading} />
          <KpiTile label="Collected fees" value={recon ? formatCurrency(recon.collected_fee, "INR") : "—"} hint="from customers" loading={loading} />
          <KpiTile
            label="Margin"
            value={recon ? formatCurrency(recon.margin, "INR") : "—"}
            hint={recon && recon.margin < 0 ? "subsidy" : "surplus"}
            loading={loading}
          />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent">
            <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} /> Refresh
          </button>
          <p className="text-xs text-muted-foreground">
            Provider keys + connection test are managed in the Fe3dr API admin (not here).
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">Error: {error}</div>
        ) : null}

        {/* Providers */}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 text-right font-medium">Priority</th>
                <th className="px-3 py-2 text-right font-medium">Base cost</th>
                <th className="px-3 py-2 text-right font-medium">Deliveries</th>
                <th className="px-3 py-2 text-right font-medium">Success</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && providers.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : providers.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No providers configured.</td></tr>
              ) : (
                providers.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{p.code}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.priority}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(p.base_cost, "INR")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(p.total_deliveries)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.success_rate.toFixed(1)}%</td>
                    <td className="px-3 py-2">
                      <span className={
                        "rounded-full px-2 py-0.5 text-xs " +
                        (p.is_enabled ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground")
                      }>
                        {p.is_enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => void toggle(p)}
                        disabled={busyId === p.id}
                        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                      >
                        {busyId === p.id ? "…" : p.is_enabled ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
