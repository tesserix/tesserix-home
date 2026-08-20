// Imported from `./platform-api-error`, not from `./platform-api`: this module
// is reached from client components, and a value import from `./platform-api`
// drags `pg` into the browser bundle (see that file's header).
import { PlatformApiError } from "./platform-api-error";

/**
 * The AI path's cost and token usage, as observed at agentgateway.
 *
 * The gateway is the only place that sees provider, model, token counts and
 * guardrail verdicts for every product at once, which is why this surface reads
 * from it rather than from each product's own accounting. It is NOT a bill:
 * Kora's `ai_usage_events` remains the billing authority, and the two differ by
 * the traffic the gateway refused before it reached a provider.
 */

export const AI_USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type AiUsageWindowKey = (typeof AI_USAGE_WINDOWS)[number];

export const AI_USAGE_AXES = ["product", "provider", "model", "capability", "gateway"] as const;
export type AiUsageAxis = (typeof AI_USAGE_AXES)[number];

export const AI_OUTCOMES = [
  "ok",
  "guardrail_blocked",
  "rate_limited",
  "provider_error",
  "gateway_error",
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

const GUARDRAIL_ACTIONS = ["reject", "mask"] as const;
export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

/** `cachedInput` is a subset of `input`; summing all three double-counts. */
export interface AiTokens {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
}

export interface AiUsageWindow {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly bucketSeconds: number;
}

export interface AiUsageTotals {
  readonly requests: number;
  readonly tokens: AiTokens;
  readonly costUsd: number;
  readonly ok: number;
  readonly blocked: number;
  readonly rateLimited: number;
  readonly errors: number;
  readonly masked: number;
}

export interface AiUsagePoint {
  readonly bucket: string;
  readonly requests: number;
  readonly tokens: AiTokens;
  readonly costUsd: number;
}

export interface AiUsageSummary {
  readonly window: AiUsageWindow;
  readonly totals: AiUsageTotals;
  readonly series: readonly AiUsagePoint[];
}

export interface AiUsageBreakdownRow {
  readonly key: string;
  readonly requests: number;
  readonly tokens: AiTokens;
  readonly costUsd: number;
  readonly errors: number;
  readonly blocked: number;
}

export interface AiUsageBreakdown {
  readonly window: AiUsageWindow;
  readonly by: string;
  readonly rows: readonly AiUsageBreakdownRow[];
}

export interface GuardrailRule {
  readonly rule: string;
  readonly action: GuardrailAction;
  readonly product: string;
  readonly requests: number;
  readonly lastSeen: string;
}

export interface AiUsageGuardrails {
  readonly window: AiUsageWindow;
  readonly blocked: number;
  readonly masked: number;
  readonly rateLimited: number;
  readonly rules: readonly GuardrailRule[];
}

export interface AiUsageEvent {
  readonly spanId: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly gateway: string;
  readonly product: string;
  readonly capability: string | null;
  readonly provider: string;
  readonly requestModel: string;
  readonly responseModel: string | null;
  readonly tokens: AiTokens;
  readonly costUsd: number;
  readonly costSource: string;
  readonly statusCode: number;
  readonly outcome: AiOutcome;
  readonly guardrailAction: GuardrailAction | null;
  readonly guardrailRule: string | null;
  readonly latencyMs: number | null;
}

export interface AiUsageEvents {
  readonly window: AiUsageWindow;
  readonly events: readonly AiUsageEvent[];
}

// The parsers reject a malformed payload rather than coercing it, for the
// reason every cost surface has to: a missing number rendered as zero is not a
// gap, it is a claim that nothing was spent.

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformApiError(`ai usage: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`ai usage: ${path} is not a number`);
  }
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new PlatformApiError(`ai usage: ${path} is not a string`);
  }
  return value;
}

function nullableStr(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, path);
}

function nullableNum(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return num(value, path);
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlatformApiError(`ai usage: ${path} is not an array`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const raw = str(value, path);
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new PlatformApiError(`ai usage: ${path} is not one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

function parseTokens(value: unknown, path: string): AiTokens {
  const t = obj(value, path);
  return {
    input: num(t.input, `${path}.input`),
    output: num(t.output, `${path}.output`),
    cachedInput: num(t.cached_input, `${path}.cached_input`),
  };
}

function parseWindow(value: unknown): AiUsageWindow {
  const w = obj(value, "window");
  return {
    key: str(w.key, "window.key"),
    from: str(w.from, "window.from"),
    to: str(w.to, "window.to"),
    bucketSeconds: num(w.bucket_seconds, "window.bucket_seconds"),
  };
}

function parseTotals(value: unknown, path: string): AiUsageTotals {
  const t = obj(value, path);
  return {
    requests: num(t.requests, `${path}.requests`),
    tokens: parseTokens(t.tokens, `${path}.tokens`),
    costUsd: num(t.cost_usd, `${path}.cost_usd`),
    ok: num(t.ok_requests, `${path}.ok_requests`),
    blocked: num(t.blocked_requests, `${path}.blocked_requests`),
    rateLimited: num(t.rate_limited_requests, `${path}.rate_limited_requests`),
    errors: num(t.error_requests, `${path}.error_requests`),
    masked: num(t.masked_requests, `${path}.masked_requests`),
  };
}

export function parseAiUsageSummary(json: unknown): AiUsageSummary {
  const root = obj(json, "response");
  return {
    window: parseWindow(root.window),
    totals: parseTotals(root.totals, "totals"),
    series: arr(root.series, "series").map((raw, i) => {
      const point = obj(raw, `series[${i}]`);
      return {
        bucket: str(point.bucket, `series[${i}].bucket`),
        requests: num(point.requests, `series[${i}].requests`),
        tokens: parseTokens(point.tokens, `series[${i}].tokens`),
        costUsd: num(point.cost_usd, `series[${i}].cost_usd`),
      };
    }),
  };
}

export function parseAiUsageBreakdown(json: unknown): AiUsageBreakdown {
  const root = obj(json, "response");
  return {
    window: parseWindow(root.window),
    by: str(root.by, "by"),
    rows: arr(root.rows, "rows").map((raw, i) => {
      const row = obj(raw, `rows[${i}]`);
      return {
        key: str(row.key, `rows[${i}].key`),
        requests: num(row.requests, `rows[${i}].requests`),
        tokens: parseTokens(row.tokens, `rows[${i}].tokens`),
        costUsd: num(row.cost_usd, `rows[${i}].cost_usd`),
        errors: num(row.error_requests, `rows[${i}].error_requests`),
        blocked: num(row.blocked_requests, `rows[${i}].blocked_requests`),
      };
    }),
  };
}

export function parseAiUsageGuardrails(json: unknown): AiUsageGuardrails {
  const root = obj(json, "response");
  return {
    window: parseWindow(root.window),
    blocked: num(root.blocked_requests, "blocked_requests"),
    masked: num(root.masked_requests, "masked_requests"),
    rateLimited: num(root.rate_limited_requests, "rate_limited_requests"),
    rules: arr(root.rules, "rules").map((raw, i) => {
      const rule = obj(raw, `rules[${i}]`);
      return {
        rule: str(rule.rule, `rules[${i}].rule`),
        action: oneOf(rule.action, GUARDRAIL_ACTIONS, `rules[${i}].action`),
        product: str(rule.product, `rules[${i}].product`),
        requests: num(rule.requests, `rules[${i}].requests`),
        lastSeen: str(rule.last_seen, `rules[${i}].last_seen`),
      };
    }),
  };
}

export function parseAiUsageEvents(json: unknown): AiUsageEvents {
  const root = obj(json, "response");
  return {
    window: parseWindow(root.window),
    events: arr(root.events, "events").map((raw, i) => {
      const e = obj(raw, `events[${i}]`);
      return {
        spanId: str(e.span_id, `events[${i}].span_id`),
        traceId: str(e.trace_id, `events[${i}].trace_id`),
        occurredAt: str(e.occurred_at, `events[${i}].occurred_at`),
        gateway: str(e.gateway, `events[${i}].gateway`),
        product: str(e.product, `events[${i}].product`),
        capability: nullableStr(e.capability, `events[${i}].capability`),
        provider: str(e.provider, `events[${i}].provider`),
        requestModel: str(e.request_model, `events[${i}].request_model`),
        responseModel: nullableStr(e.response_model, `events[${i}].response_model`),
        tokens: parseTokens(e.tokens, `events[${i}].tokens`),
        costUsd: num(e.cost_usd, `events[${i}].cost_usd`),
        costSource: str(e.cost_source, `events[${i}].cost_source`),
        statusCode: num(e.status_code, `events[${i}].status_code`),
        outcome: oneOf(e.outcome, AI_OUTCOMES, `events[${i}].outcome`),
        guardrailAction:
          e.guardrail_action === null || e.guardrail_action === undefined
            ? null
            : oneOf(e.guardrail_action, GUARDRAIL_ACTIONS, `events[${i}].guardrail_action`),
        guardrailRule: nullableStr(e.guardrail_rule, `events[${i}].guardrail_rule`),
        latencyMs: nullableNum(e.latency_ms, `events[${i}].latency_ms`),
      };
    }),
  };
}

/**
 * Money, at the precision the number actually has.
 *
 * One gateway request costs fractions of a cent, so two decimal places render a
 * real cost as "$0.00" — which reads as free. Below a cent the formatter keeps
 * four places; above it, two, because nobody reads a monthly total to the
 * hundredth of a cent.
 */
export function costFormatter(usd: number): string {
  if (usd > 0 && usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/** Token counts run to millions; the exact digit is never the point. */
export function tokenFormatter(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** The share of input tokens served from the provider's prompt cache. */
export function cacheHitRate(tokens: AiTokens): number {
  return tokens.input === 0 ? 0 : tokens.cachedInput / tokens.input;
}
