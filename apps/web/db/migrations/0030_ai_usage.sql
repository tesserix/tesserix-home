-- 0030_ai_usage.sql
--
-- The AI path's token and cost ledger, as OBSERVED AT THE GATEWAY.
--
-- Every product's LLM traffic goes through one agentgateway data plane
-- (agentgateway-system), which is the only place that sees provider, model,
-- token counts, guardrail verdicts and rate-limit rejections for all of them at
-- once. This is where that stream lands so the console can read it.
--
-- NOT a billing ledger. Kora's own `ai_usage_events` remains the billing and
-- budget authority (tesserix-k8s/docs/kora-ai-gateway.md); these rows are
-- operational evidence, and the two are expected to differ slightly — a request
-- the gateway rejected never reached a provider and was never billed.
--
-- Prompts and completions are deliberately absent. The gateway masks emails and
-- phone numbers and rejects card/SSN prompts, but the safe way to keep customer
-- prompts out of the console's database is not to carry a column for them.

BEGIN;

-- =======================================================================
-- One row per LLM request the gateway completed or refused.
--
-- Keyed by the OTLP span id, not a generated id: ingest is at-least-once
-- (JetStream redelivers on any consumer failure), so the natural key is what
-- makes a replay idempotent rather than a duplicate bill.
-- =======================================================================
CREATE TABLE ai_usage_events (
  span_id text PRIMARY KEY,
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL,

  -- Which gateway served it (`kora-ai`, `devai-ai`). Two gateways exist today
  -- and more will; without this a cost spike cannot be attributed to a data
  -- plane, only to a product.
  gateway text NOT NULL,
  -- The calling product, from the gateway's API-key identity — not from a
  -- client-supplied header, which a caller could set to anyone.
  product text NOT NULL,
  -- What the product was doing, from `x-kora-ai-capability` and its
  -- equivalents. Client-supplied and therefore untrusted for authorisation,
  -- but it is the axis operators actually ask about ("which feature costs
  -- this much"), so it is recorded and never used as a gate.
  capability text,

  provider text NOT NULL,
  request_model text NOT NULL,
  -- Differs from request_model on provider-side aliasing and on failover.
  response_model text,

  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- Counted INSIDE input_tokens, matching gen_ai semantic conventions, so
  -- summing the three would double-count. Kept separately because cache reads
  -- are the cheapest tokens on the bill and the ratio is the reason to keep
  -- paying for a prompt cache.
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),

  cost_usd numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- 'gateway' when agentgateway priced it from its model cost catalog
  -- (`agw.ai.usage.cost.total`), 'catalog' when ingest priced it from
  -- ai_model_prices, 'unpriced' when neither could. A cost total is only
  -- honest next to how it was arrived at.
  cost_source text NOT NULL CHECK (cost_source IN ('gateway', 'catalog', 'unpriced')),

  status_code integer NOT NULL,
  -- Why the request ended as it did. `ok` and `provider_error` cost money;
  -- `guardrail_blocked` and `rate_limited` never reached a provider, which is
  -- the distinction the guardrails surface is built on.
  outcome text NOT NULL CHECK (outcome IN (
    'ok', 'guardrail_blocked', 'rate_limited', 'provider_error', 'gateway_error'
  )),
  -- Set only when a promptGuard rule fired. `mask` rules do not block, so a
  -- masked request is `outcome = 'ok'` with an action recorded.
  guardrail_action text CHECK (guardrail_action IN ('reject', 'mask')),
  guardrail_rule text,

  latency_ms integer CHECK (latency_ms >= 0),
  ingested_at timestamptz NOT NULL DEFAULT now()
);

-- The tail view: "what just happened", newest first.
CREATE INDEX ai_usage_events_occurred_idx ON ai_usage_events (occurred_at DESC, span_id DESC);
-- Every product-scoped read, and the retention sweep's companion.
CREATE INDEX ai_usage_events_product_idx ON ai_usage_events (product, occurred_at DESC);
-- Partial rather than a plain index on guardrail_action: guardrail hits are a
-- small fraction of traffic and the guardrails surface reads only them.
CREATE INDEX ai_usage_events_guardrail_idx ON ai_usage_events (occurred_at DESC)
  WHERE guardrail_action IS NOT NULL;

COMMENT ON TABLE ai_usage_events IS
  'Per-request AI usage observed at agentgateway. Raw rows are pruned after 30 days; ai_usage_hourly is the durable record.';

-- =======================================================================
-- Hourly rollups — what every aggregate surface reads.
--
-- A 30-day cost breakdown over raw rows is a scan of everything the estate
-- sent an LLM; over these it is a few thousand rows. Written by the same
-- ingest transaction that writes the event, so a rollup can never be missing a
-- request the events table has.
--
-- Hourly rather than daily: "the spike started at 14:00" is answerable, and a
-- day bucket cannot be split back up afterwards.
-- =======================================================================
CREATE TABLE ai_usage_hourly (
  bucket timestamptz NOT NULL,
  gateway text NOT NULL,
  product text NOT NULL,
  capability text NOT NULL DEFAULT '',
  provider text NOT NULL,
  request_model text NOT NULL,

  requests bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0,

  ok_requests bigint NOT NULL DEFAULT 0,
  blocked_requests bigint NOT NULL DEFAULT 0,
  rate_limited_requests bigint NOT NULL DEFAULT 0,
  error_requests bigint NOT NULL DEFAULT 0,
  masked_requests bigint NOT NULL DEFAULT 0,

  -- `capability` is '' rather than NULL for uncategorised traffic because it is
  -- part of the primary key, and NULL is not equal to itself: two upserts for
  -- the same uncategorised hour would insert two rows instead of summing.
  PRIMARY KEY (bucket, gateway, product, capability, provider, request_model)
);

CREATE INDEX ai_usage_hourly_bucket_idx ON ai_usage_hourly (bucket DESC);

-- =======================================================================
-- Model prices, effective-dated.
--
-- Used only when agentgateway did not price the request itself. Effective-dated
-- rather than a current-price column so a historical hour keeps the cost it
-- actually incurred when a provider changes its rate card.
-- =======================================================================
CREATE TABLE ai_model_prices (
  provider text NOT NULL,
  model text NOT NULL,
  -- cached_input is a separate kind, not a discount applied to input: the
  -- providers price it separately and the ratio differs per provider.
  token_kind text NOT NULL CHECK (token_kind IN ('input', 'output', 'cached_input')),
  usd_per_million numeric(12, 6) NOT NULL CHECK (usd_per_million >= 0),
  effective_from timestamptz NOT NULL,
  PRIMARY KEY (provider, model, token_kind, effective_from)
);

COMMENT ON TABLE ai_model_prices IS
  'Fallback pricing for requests agentgateway did not price. Rows are added by operators, not by ingest.';

COMMIT;
