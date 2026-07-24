// M2 — Custom-domain DNS + cert verification dashboard.
//
// Source: mark8ly_marketplace_api.custom_domains (per-domain config and
// status tracked by tenant-router-service). Tenants table lives in
// platform_api so we read from both pools and join in JS.
//
// We intentionally don't make live DNS queries from the dashboard —
// that's the job of tenant-router-service's verification loop. We
// surface what tenant-router has already verified (verified_at,
// status, cert_status, error_message). Operators wanting a fresh
// check can trigger one via tenant-router's admin API.

import { mark8lyQuery } from "./mark8ly";

export type DomainStatus = "pending" | "active" | "failed" | "verifying";
export type SSLStatus = "pending" | "active" | "failed";
export type CertStatus = "pending" | "issuing" | "ready" | "failed";
export type DNSMethod = "manual" | "cloudflare";

export interface CustomDomainRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly tenantSlug: string | null;
  readonly storeId: string;
  readonly domain: string;
  readonly status: DomainStatus;
  readonly dnsMethod: DNSMethod;
  readonly cnameTarget: string | null;
  readonly sslStatus: SSLStatus;
  readonly certStatus: CertStatus;
  readonly certError: string | null;
  readonly errorMessage: string | null;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawDomainRow {
  id: string;
  tenant_id: string;
  store_id: string;
  domain: string;
  status: string;
  dns_method: string;
  cname_target: string | null;
  ssl_status: string;
  cert_status: string;
  cert_error: string | null;
  error_message: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTenantRow {
  id: string;
  name: string | null;
  slug: string | null;
}

function clampStatus(raw: string): DomainStatus {
  switch (raw) {
    case "active":
    case "failed":
    case "verifying":
      return raw;
    default:
      return "pending";
  }
}

function clampSSL(raw: string): SSLStatus {
  switch (raw) {
    case "active":
    case "failed":
      return raw;
    default:
      return "pending";
  }
}

function clampCert(raw: string): CertStatus {
  switch (raw) {
    case "issuing":
    case "ready":
    case "failed":
      return raw;
    default:
      return "pending";
  }
}

function clampDNSMethod(raw: string): DNSMethod {
  return raw === "cloudflare" ? "cloudflare" : "manual";
}

export async function listCustomDomains(): Promise<CustomDomainRow[]> {
  const domainSql = `
    SELECT id, tenant_id, store_id, domain, status, dns_method, cname_target,
           ssl_status, cert_status, cert_error, error_message, verified_at,
           created_at, updated_at
    FROM custom_domains
    ORDER BY
      CASE status
        WHEN 'failed' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'verifying' THEN 2
        WHEN 'active' THEN 3
        ELSE 4
      END,
      created_at DESC
  `;
  const domainRes = await mark8lyQuery<RawDomainRow>("marketplace_api", domainSql);
  if (domainRes.rows.length === 0) return [];

  // Enrich with tenant name/slug — tenants table lives in platform_api.
  const tenantIds = Array.from(new Set(domainRes.rows.map((r) => r.tenant_id)));
  const placeholders = tenantIds.map((_, i) => `$${i + 1}`).join(",");
  const tenantSql = `
    SELECT id::text AS id, name, slug
    FROM tenants
    WHERE id::text = ANY(ARRAY[${placeholders}]::text[])
  `;
  const tenantRes = await mark8lyQuery<RawTenantRow>(
    "platform_api",
    tenantSql,
    tenantIds,
  ).catch(() => ({ rows: [] as RawTenantRow[] }));
  const tenantById = new Map<string, RawTenantRow>(
    tenantRes.rows.map((t) => [t.id, t]),
  );

  return domainRes.rows.map((r) => {
    const t = tenantById.get(r.tenant_id);
    return {
      id: r.id,
      tenantId: r.tenant_id,
      tenantName: t?.name ?? null,
      tenantSlug: t?.slug ?? null,
      storeId: r.store_id,
      domain: r.domain,
      status: clampStatus(r.status),
      dnsMethod: clampDNSMethod(r.dns_method),
      cnameTarget: r.cname_target,
      sslStatus: clampSSL(r.ssl_status),
      certStatus: clampCert(r.cert_status),
      certError: r.cert_error,
      errorMessage: r.error_message,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}
