-- 0012 — Seed the apps registry (tesserix_admin.apps) as an auto-applied,
-- idempotent migration.
--
-- Why this exists: the Admin → Apps grid is DB-driven from `apps`, but the
-- registry rows lived only in db/seeds/apps.sql, which `db:migrate` does NOT run
-- (it applies db/migrations/* only). So the rows were applied by hand at cutover
-- and a DB refresh / re-seed silently dropped them — that's how the HomeChef tile
-- vanished (Home-Chef-App#59). Seeding the registry as a migration makes it
-- persist + apply automatically on deploy.
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps each row in sync with the
-- values checked in here. Mirror any change in db/seeds/apps.sql (kept for
-- manual/ad-hoc re-seeds) and this migration together.

INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'mark8ly',
  'Mark8ly',
  'Multi-tenant commerce platform — merchant onboarding, storefront, and admin.',
  'active',
  'mark8ly',
  'mark8ly-postgres-rw.mark8ly.svc.cluster.local',
  5432,
  'mark8ly-platform-admin',
  '["mark8ly_platform_api", "mark8ly_marketplace_api"]'::jsonb,
  'mark8ly.com',
  'https://{slug}-admin.mark8ly.com'
),
(
  'homechef',
  'Fe3dr',
  'Home-cooked food delivery — chefs cook, drivers deliver, customers order.',
  'active',
  'homechef',
  'homechef-postgres-rw.homechef.svc.cluster.local',
  5432,
  'homechef-platform-admin',
  '["homechef_db"]'::jsonb,
  'fe3dr.com',
  'https://admin.fe3dr.com'
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
