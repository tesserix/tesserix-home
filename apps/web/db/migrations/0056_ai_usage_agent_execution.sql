SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE ai_usage_events
  ADD COLUMN agent_id text,
  ADD COLUMN agent_version text,
  ADD COLUMN agent_run_id text;
-- Rollback retains additive nullable columns to preserve accounting evidence.
RESET lock_timeout;
RESET statement_timeout;
