-- 0013 — Add DevAI to the apps registry (tesserix_admin.apps), same auto-applied,
-- idempotent pattern as 0012. DevAI is the AI-powered ALM + SRE platform
-- (namespace devai, CNPG devai-postgres, dashboard at devai.tesserix.app). Its
-- analytics/logs flow via OTel→ClickHouse (ServiceName LIKE 'devai%'), incidents
-- via platform_tickets (product_id='devai'), service health by namespace.
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with the values
-- checked in here. Mirror any change in db/seeds/apps.sql and this migration
-- together.
--
-- Note: db_admin_secret_name references the cross-DB admin role/secret
-- (devai-platform-admin) provisioned via the cross-db-admin runbook. The
-- directory tile renders without it; only cross-DB admin queries need it.

INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'devai',
  'DevAI',
  'AI-powered ALM + SRE platform — agents for application lifecycle and incident response.',
  'active',
  'devai',
  'devai-postgres-rw.devai.svc.cluster.local',
  5432,
  'devai-platform-admin',
  '["devai_db"]'::jsonb,
  'devai.tesserix.app',
  'https://devai.tesserix.app'
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
