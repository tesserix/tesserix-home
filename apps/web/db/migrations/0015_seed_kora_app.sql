-- 0015 — Add Kora to the apps registry (tesserix_admin.apps), same auto-applied,
-- idempotent pattern as 0013. Kora is the AI food-logging product: an Expo
-- mobile app plus a single Go API (kora-api) in namespace `kora`, backed by its
-- own CloudNativePG cluster `kora-postgres` (provisioned 2026-08-04 — it ran on
-- the shared global-postgres before that).
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with the values
-- checked in here. Mirror any change in db/seeds/apps.sql and this migration
-- together.
--
-- db_admin_secret_name is left NULL deliberately: Phase 1 is READ-ONLY and gets
-- everything from Prometheus, so no cross-DB admin role has been provisioned.
-- The directory tile renders without it. Phase 3 (user management) is where that
-- decision gets made — and the design there splits reads from writes, so it may
-- never need one.

INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'kora',
  'Kora',
  'AI food logging — photo, voice and text meal capture with a nutrition index and coaching.',
  'active',
  'kora',
  'kora-postgres-rw.kora.svc.cluster.local',
  5432,
  NULL,
  '["kora_db"]'::jsonb,
  'kora-api.tesserix.app',
  'https://kora-api.tesserix.app'
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
