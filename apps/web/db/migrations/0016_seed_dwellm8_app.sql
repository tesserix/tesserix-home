-- 0016 — Add Dwellm8 to the apps registry (tesserix_admin.apps), same
-- auto-applied, idempotent pattern as 0013 and 0015. Dwellm8 is a real,
-- deployed product — property management for India, 9 ArgoCD applications,
-- a 60+ file schema with a paise-denominated append-only ledger and
-- statutory (TDS) reporting — but it was deployed long before it was
-- registered here, so the console's Admin → Apps grid never had a row for
-- it and its overview rendered nothing.
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with the
-- values checked in here. Mirror any change in db/seeds/apps.sql and this
-- migration together.
--
-- Connection values are read from tesserix-k8s (read-only), not guessed:
--   db_namespace   -> charts/apps/dwellm8-postgres/values.yaml:9  (namespace: dwellm8)
--   db_host        -> charts/apps/dwellm8-api/values.yaml:157     (database.host:
--                      dwellm8-postgres-rw.dwellm8.svc.cluster.local), confirmed by
--                      argocd/prod/apps/dwellm8/dwellm8-db-schema-bootstrap.yaml:32
--   db_port        -> charts/apps/dwellm8-api/values.yaml:158 (database.port: 5432)
--   db_databases   -> argocd/prod/apps/dwellm8/dwellm8-db-schema-bootstrap.yaml:31-49
--                      (targets: dwellm8, openfga), confirmed by the schema tree at
--                      charts/apps/db-schema-bootstrap/schemas/dwellm8/{dwellm8,openfga}/
--   primary_domain -> charts/apps/dwellm8-api/values.yaml:60 (istio.hosts: api.dwellm8.com),
--                      the one public host — same "mobile app + single API, no separate
--                      admin UI" shape as Kora (0015), so primary_domain/admin_url follow
--                      that established precedent rather than a guessed admin subdomain.
--
-- db_admin_secret_name is left NULL deliberately, same rationale as Kora (0015):
-- no cross-DB admin role has been provisioned for Dwellm8:
--   dwellm8_api      — what a request runs as, cannot bypass RLS (ADR-0003 §3)
--   dwellm8_platform — the audited cross-tenant exemption
-- Neither is a read-only oversight role, so the directory tile renders without one.

INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'dwellm8',
  'Dwellm8',
  'Property management for India — leases, statutory (TDS) reporting, and a paise-denominated append-only ledger.',
  'active',
  'dwellm8',
  'dwellm8-postgres-rw.dwellm8.svc.cluster.local',
  5432,
  NULL,
  '["dwellm8", "openfga"]'::jsonb,
  'api.dwellm8.com',
  'https://api.dwellm8.com'
)
ON CONFLICT (slug) DO UPDATE SET
  name                  = EXCLUDED.name,
  description           = EXCLUDED.description,
  status                = EXCLUDED.status,
  db_namespace          = EXCLUDED.db_namespace,
  db_host               = EXCLUDED.db_host,
  db_port               = EXCLUDED.db_port,
  db_admin_secret_name  = EXCLUDED.db_admin_secret_name,
  db_databases          = EXCLUDED.db_databases,
  primary_domain        = EXCLUDED.primary_domain,
  admin_url             = EXCLUDED.admin_url;
