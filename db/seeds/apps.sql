-- Seed the apps registry with each product this super-admin oversees.
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with
-- whatever's checked in here, so re-running the seed is safe.
--
-- When adding a new product (fanzone, homechef, …):
--   1. Provision its mark8ly_platform_admin-equivalent role per
--      tesserix-k8s/docs/cross-db-admin.md.
--   2. Add an ExternalSecret in tesserix namespace named <product>-platform-admin.
--   3. Append an INSERT below.
--   4. Re-run this seed.

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

-- HomeChef — home-cooked food delivery (fe3dr.com). Single Postgres database
-- (homechef_db) in the postgresql-homechef namespace. Admin oversight reads KPIs
-- as homechef_platform_admin (HOMECHEF_DB_* from the homechef-platform-admin
-- ExternalSecret). This row is what makes the HomeChef tile appear in the
-- Admin → Apps grid; the tile was missing because the row was never seeded (#59).
INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'homechef',
  'HomeChef',
  'Home-cooked food delivery — chefs cook, drivers deliver, customers order.',
  'active',
  'postgresql-homechef',
  'postgresql.postgresql-homechef.svc.cluster.local',
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
