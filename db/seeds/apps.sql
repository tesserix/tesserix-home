-- Seed the apps registry with each product this super-admin oversees.
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with
-- whatever's checked in here, so re-running the seed is safe.
--
-- AUTO-APPLY: `db:migrate` does NOT run this seed — it runs db/migrations/* only.
-- The canonical, auto-applied copy of this registry is the idempotent migration
-- db/migrations/0012_seed_apps_registry.sql. Keep the two in sync: when you add
-- or change a product here, mirror it in 0012 (or add a follow-up migration) so
-- the row actually persists on deploy. This file remains for manual/ad-hoc seeds.
--
-- When adding a new product (fanzone, homechef, …):
--   1. Provision its mark8ly_platform_admin-equivalent role per
--      tesserix-k8s/docs/cross-db-admin.md.
--   2. Add an ExternalSecret in tesserix namespace named <product>-platform-admin.
--   3. Append an INSERT below AND mirror it in db/migrations/0012_seed_apps_registry.sql.
--   4. Deploy (db:migrate auto-applies the migration); re-run this seed only for ad-hoc fixes.

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

-- Fe3dr / HomeChef — home-cooked food delivery. Single database (homechef_db),
-- oversight reads as homechef_platform_admin (HOMECHEF_DB_* from the
-- homechef-platform-admin ExternalSecret). The product integration (config,
-- cross-DB pool, KPI route, overview, sidebar) already shipped; this row is what
-- makes the tile appear in the Admin → Apps grid. It was inserted manually during
-- the 2026-06-12 cutover but never added here, so a DB refresh dropped it and the
-- tile vanished (#59). Seeding it makes the tile durable across re-seeds.
-- Canonical values: Home-Chef-App/docs/ops/CUTOVER-RUNBOOK.md §1.
INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
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
