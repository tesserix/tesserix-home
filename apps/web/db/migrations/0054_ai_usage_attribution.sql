SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE ai_usage_events
  ADD COLUMN user_id text,
  ADD COLUMN service_name text;
-- Additive migration: older writers and readers remain compatible. Rollback
-- retains these nullable columns so collected attribution is not destroyed.
ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_cost_source_check;
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_events_cost_source_check
  CHECK (cost_source IN ('gateway', 'catalog', 'partial', 'unpriced')) NOT VALID;
ALTER TABLE ai_usage_events VALIDATE CONSTRAINT ai_usage_events_cost_source_check;
ALTER TABLE ai_usage_events ALTER COLUMN cost_usd TYPE numeric(20,12);
ALTER TABLE ai_usage_hourly ALTER COLUMN cost_usd TYPE numeric(20,12);
RESET lock_timeout;
RESET statement_timeout;
