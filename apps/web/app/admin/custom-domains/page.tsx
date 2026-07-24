"use client";

// M2 — Custom-domain DNS verification dashboard.
//
// Surfaces what tenant-router-service has already verified, plus a
// roll-up at the top so any failed/pending state pops to attention.
// Live DNS lookups are intentionally NOT done from the dashboard —
// tenant-router owns the verification loop and writes its findings
// back to mark8ly_marketplace_api.custom_domains.

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import { KpiTile } from "@/components/admin/metrics/kpi-tile";

type DomainStatus = "pending" | "active" | "failed" | "verifying";
type SSLStatus = "pending" | "active" | "failed";
type CertStatus = "pending" | "issuing" | "ready" | "failed";
type DNSMethod = "manual" | "cloudflare";

interface CustomDomain {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  storeId: string;
  domain: string;
  status: DomainStatus;
  dnsMethod: DNSMethod;
  cnameTarget: string | null;
  sslStatus: SSLStatus;
  certStatus: CertStatus;
  certError: string | null;
  errorMessage: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const STATUS_TONE: Record<DomainStatus, string> = {
  active: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
  verifying: "bg-sky-50 text-sky-700",
  failed: "bg-rose-50 text-rose-700",
};

const SSL_TONE: Record<SSLStatus, string> = {
  active: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
  failed: "bg-rose-50 text-rose-700",
};

const CERT_TONE: Record<CertStatus, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  issuing: "bg-sky-50 text-sky-700",
  pending: "bg-amber-50 text-amber-700",
  failed: "bg-rose-50 text-rose-700",
};

export default function CustomDomainsPage() {
  const { data, error, isLoading, mutate } = useSWR<{ domains: CustomDomain[] }>(
    "/api/admin/custom-domains",
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false },
  );

  const [statusFilter, setStatusFilter] = useState<DomainStatus | "">("");
  const [methodFilter, setMethodFilter] = useState<DNSMethod | "">("");
  // Per-row "in flight" tracker so the right button on the right row
  // shows a spinner while we wait for the upstream call.
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{
    id: string;
    text: string;
    tone: "ok" | "err";
  } | null>(null);

  async function triggerAction(
    id: string,
    action: "verify" | "refresh-status",
  ): Promise<void> {
    setBusyRow(`${id}:${action}`);
    setActionMsg(null);
    try {
      const res = await fetch(
        `/api/admin/custom-domains/${encodeURIComponent(id)}/${action}`,
        { method: "POST", credentials: "include" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setActionMsg({
          id,
          text: body.message ?? body.error ?? `HTTP ${res.status}`,
          tone: "err",
        });
        return;
      }
      setActionMsg({
        id,
        text: action === "verify" ? "Re-verify queued ✓" : "Cert status refreshed ✓",
        tone: "ok",
      });
      await mutate();
    } catch (err) {
      setActionMsg({
        id,
        text: err instanceof Error ? err.message : String(err),
        tone: "err",
      });
    } finally {
      setBusyRow(null);
    }
  }

  const domains = data?.domains ?? [];

  const totals = useMemo(() => {
    return domains.reduce(
      (acc, d) => ({
        total: acc.total + 1,
        active: acc.active + (d.status === "active" ? 1 : 0),
        pending:
          acc.pending +
          (d.status === "pending" || d.status === "verifying" ? 1 : 0),
        failed:
          acc.failed +
          (d.status === "failed" ||
          d.sslStatus === "failed" ||
          d.certStatus === "failed"
            ? 1
            : 0),
        certIssues:
          acc.certIssues +
          (d.certStatus === "failed" || d.certStatus === "issuing" ? 1 : 0),
      }),
      { total: 0, active: 0, pending: 0, failed: 0, certIssues: 0 },
    );
  }, [domains]);

  const filtered = useMemo(
    () =>
      domains.filter((d) => {
        if (statusFilter && d.status !== statusFilter) return false;
        if (methodFilter && d.dnsMethod !== methodFilter) return false;
        return true;
      }),
    [domains, statusFilter, methodFilter],
  );

  const failedDomains = domains.filter(
    (d) =>
      d.status === "failed" ||
      d.sslStatus === "failed" ||
      d.certStatus === "failed",
  );

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Custom domains"
        description="DNS + SSL + cert verification status for every tenant's custom domain. Sourced from mark8ly's custom_domains table; refreshes every 60s."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KpiTile
            label="Domains"
            value={String(totals.total)}
            loading={isLoading}
          />
          <KpiTile
            label="Active"
            value={String(totals.active)}
            hint="DNS + SSL + cert OK"
            loading={isLoading}
          />
          <KpiTile
            label="Pending"
            value={String(totals.pending)}
            hint="awaiting verification"
            loading={isLoading}
          />
          <KpiTile
            label="Failed"
            value={String(totals.failed)}
            hint="DNS / SSL / cert"
            loading={isLoading}
          />
          <KpiTile
            label="Cert issues"
            value={String(totals.certIssues)}
            hint="failed or stuck issuing"
            loading={isLoading}
          />
        </div>

        {failedDomains.length > 0 && (
          <div className="space-y-2 rounded-lg border border-rose-300/40 bg-rose-50 p-4 text-sm text-rose-900">
            <p className="font-medium">
              {failedDomains.length} domain
              {failedDomains.length === 1 ? "" : "s"} need attention
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {failedDomains.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <span className="font-mono">{d.domain}</span> —{" "}
                  {d.errorMessage ||
                    d.certError ||
                    `${d.status}/${d.sslStatus}/${d.certStatus}`}
                </li>
              ))}
              {failedDomains.length > 5 && (
                <li className="text-muted-foreground">
                  …and {failedDomains.length - 5} more
                </li>
              )}
            </ul>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Could not load custom domains.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-1.5">
          <FilterPill
            label="All status"
            active={!statusFilter}
            onClick={() => setStatusFilter("")}
          />
          {(["active", "pending", "verifying", "failed"] as const).map((s) => (
            <FilterPill
              key={s}
              label={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <FilterPill
            label="All methods"
            active={!methodFilter}
            onClick={() => setMethodFilter("")}
          />
          {(["manual", "cloudflare"] as const).map((m) => (
            <FilterPill
              key={m}
              label={m}
              active={methodFilter === m}
              onClick={() => setMethodFilter(m)}
            />
          ))}
        </div>

        {!isLoading && filtered.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">
              {domains.length === 0
                ? "No custom domains configured."
                : "No domains match the current filter."}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Domain</th>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">DNS</th>
                  <th className="px-4 py-3">SSL</th>
                  <th className="px-4 py-3">Cert</th>
                  <th className="px-4 py-3">Verified</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{d.domain}</td>
                    <td className="px-4 py-3 text-xs">
                      {d.tenantName ? (
                        <>
                          <span>{d.tenantName}</span>
                          {d.tenantSlug && (
                            <span className="ml-1 text-muted-foreground">
                              ({d.tenantSlug})
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="font-mono text-muted-foreground">
                          {d.tenantId.slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={STATUS_TONE[d.status]} text={d.status} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="text-muted-foreground">{d.dnsMethod}</span>
                      {d.cnameTarget && d.dnsMethod === "manual" && (
                        <span
                          className="ml-1 block truncate font-mono text-[10px]"
                          title={d.cnameTarget}
                        >
                          → {d.cnameTarget}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={SSL_TONE[d.sslStatus]} text={d.sslStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={CERT_TONE[d.certStatus]} text={d.certStatus} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {d.verifiedAt
                        ? new Date(d.verifiedAt).toLocaleString()
                        : "—"}
                    </td>
                    <td
                      className="max-w-[20rem] px-4 py-3 text-xs text-muted-foreground"
                      title={d.errorMessage ?? d.certError ?? ""}
                    >
                      <span className="block truncate">
                        {d.errorMessage ?? d.certError ?? "—"}
                      </span>
                      {actionMsg?.id === d.id && (
                        <span
                          className={
                            "mt-1 block text-[10px] " +
                            (actionMsg.tone === "ok"
                              ? "text-emerald-700"
                              : "text-rose-700")
                          }
                        >
                          {actionMsg.text}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyRow !== null}
                          onClick={() => triggerAction(d.id, "verify")}
                          title="Re-run DNS + cert provisioning checks against the carrier / cert-manager"
                        >
                          {busyRow === `${d.id}:verify` ? "…" : "Verify"}
                        </Button>
                        {d.dnsMethod === "manual" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyRow !== null}
                            onClick={() => triggerAction(d.id, "refresh-status")}
                            title="Sync cert_status with cert-manager (manual DNS only)"
                          >
                            {busyRow === `${d.id}:refresh-status` ? "…" : "Refresh cert"}
                          </Button>
                        )}
                      </div>
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

function Pill({ tone, text }: { tone: string; text: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {text}
    </span>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50")
      }
    >
      {label}
    </button>
  );
}
