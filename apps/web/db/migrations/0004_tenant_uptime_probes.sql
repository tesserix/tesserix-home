-- 0004_tenant_uptime_probes.sql
--
-- Synthetic uptime probe results for tenant-facing subdomains
-- (storefront, admin, etc.). Written by an in-cluster cron that calls
-- /api/internal/uptime/probe on a 5-minute cadence; read by the
-- /admin/uptime page and the per-tenant detail surface.
--
-- One row per (subdomain, probe time). Older rows are pruned by a
-- separate sweep job (TBD — for now just rely on TimescaleDB-style
-- DELETE WHERE probed_at < now() - interval '30 days' on the cron).

CREATE TABLE IF NOT EXISTS tenant_uptime_probes (
  id           BIGSERIAL PRIMARY KEY,
  product_id   TEXT NOT NULL,
  tenant_id    UUID NOT NULL,
  -- Hostname we probed, e.g. "the-bondi-store.mark8ly.com". Stored
  -- denormalized so a tenant rename / domain change doesn't lose
  -- historical context.
  hostname     TEXT NOT NULL,
  probed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  http_status  INTEGER,
  latency_ms   INTEGER,
  ok           BOOLEAN NOT NULL,
  -- Free-form error code when ok=false (timeout, dns_error, http_5xx,
  -- http_4xx). Kept as text not enum so a new failure mode can land
  -- without a migration.
  error        TEXT
);

CREATE INDEX IF NOT EXISTS tenant_uptime_probes_tenant_idx
  ON tenant_uptime_probes (product_id, tenant_id, probed_at DESC);

CREATE INDEX IF NOT EXISTS tenant_uptime_probes_recent_idx
  ON tenant_uptime_probes (probed_at DESC);
