import { PlatformApiError } from "./platform-api";
import type { EntityPagination } from "./entities";

/**
 * Kora's food-resolution accuracy metrics — `GET /v1/kora/ai-metrics`.
 *
 * platform-api's `koraaimetrics` module forwards Kora's `data` object
 * **unparsed** (`json.RawMessage`) — see that module's own doc comment for
 * why (§8.9's cautionary tale: a fixed struct silently drops a field nobody
 * modelled). This console is therefore the first place this shape is
 * modelled at all.
 *
 * Part 1 (`/kora` overview) modelled only `outcomes.attempts`,
 * `outcomes.needs_human` and `outcomes.first_try_rate_pct` — the three
 * numbers its three stat tiles render. Part 2 (`/kora/ai-metrics`, the full
 * surface) needs the rest of the response — `window`, `outcomes.by_kind` and
 * `users` — so this same module is extended to model them too, rather than a
 * second parser being written alongside it. `parseKoraAiMetrics` is the one
 * function both `/kora` and `/kora/ai-metrics` call.
 *
 * `by_kind` is read as a plain `Record<string, number>` rather than a fixed
 * set of named kinds. Kora zero-fills it across every kind it measures, but
 * this parser does not hardcode which those are — the same reason `kind` and
 * `severity` are rendered verbatim elsewhere in this console (`lib/inbox.ts`)
 * rather than mapped through a console-side vocabulary that could drift from
 * the product's own.
 */

export interface KoraAiWindow {
  readonly from: string;
  readonly to: string;
}

export interface KoraAiOutcomes {
  readonly attempts: number;
  readonly needsHuman: number;
  /** Every kind Kora measured this window, count included even when it is
   *  zero — see the module doc comment for why this is not a fixed set of
   *  named fields. */
  readonly byKind: Readonly<Record<string, number>>;
  /**
   * ABSENT, not `0.0`, when the measurement window had no attempts to score
   * — deliberate on Kora's side (`ai_metrics.go:37-45`). Optional here for
   * the same reason: a caller that defaults this to `0` would render a
   * confident, false zero for a window that measured nothing. See
   * `overview-view.tsx`'s `formatFirstTryRate`, which is the one place this
   * is turned into copy — reused by `/kora/ai-metrics`, not re-derived.
   */
  readonly firstTryRatePct?: number;
}

export interface KoraAiUser {
  readonly userId: string;
  readonly attempts: number;
  readonly resolves: number;
  readonly corrections: number;
  readonly budgetRefusals: number;
  readonly aiCalls: number;
  /**
   * Optional in the same way `firstTryRatePct` is: a user who has never
   * triggered an AI resolution has no last-activity instant, and that must
   * stay absent rather than being defaulted to an epoch or a string like
   * "never" — either would assert something the response did not say.
   */
  readonly lastActivityAt?: string;
}

export interface KoraAiMetrics {
  /** RFC3339 UTC, always concrete — Kora's default window when the caller
   *  sends no `from`/`to`. */
  readonly window: KoraAiWindow;
  readonly outcomes: KoraAiOutcomes;
  /** The page of users the caller asked for — see `parseKoraAiMetricsPagination`,
   *  which reads the envelope's `meta` (not a field of this object) to say
   *  which page this is. */
  readonly users: readonly KoraAiUser[];
}

function fail(message: string): never {
  throw new PlatformApiError(`kora ai metrics: ${message}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is missing`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function counter(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${path} is not a non-negative whole number`);
  }
  return value;
}

/** `first_try_rate_pct` is the one field this parser treats as genuinely
 *  optional — absent and present are both valid shapes, per Kora's own
 *  contract (`ai_metrics.go:37-45`). Present-but-not-a-number is still
 *  refused: a malformed field is a contract deviation, not an absence. */
function optionalRate(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} is not a number`);
  }
  return value;
}

function parseWindow(value: unknown, path: string): KoraAiWindow {
  const row = obj(value, path);
  return {
    from: str(row.from, `${path}.from`),
    to: str(row.to, `${path}.to`),
  };
}

function parseByKind(value: unknown, path: string): Readonly<Record<string, number>> {
  const row = obj(value, path);
  const byKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(row)) {
    byKind[kind] = counter(count, `${path}.${kind}`);
  }
  return byKind;
}

function parseOutcomes(value: unknown, path: string): KoraAiOutcomes {
  const row = obj(value, path);
  return {
    attempts: counter(row.attempts, `${path}.attempts`),
    needsHuman: counter(row.needs_human, `${path}.needs_human`),
    byKind: parseByKind(row.by_kind, `${path}.by_kind`),
    firstTryRatePct: optionalRate(row.first_try_rate_pct, `${path}.first_try_rate_pct`),
  };
}

function parseUser(value: unknown, path: string): KoraAiUser {
  const row = obj(value, path);
  return {
    userId: str(row.user_id, `${path}.user_id`),
    attempts: counter(row.attempts, `${path}.attempts`),
    resolves: counter(row.resolves, `${path}.resolves`),
    corrections: counter(row.corrections, `${path}.corrections`),
    budgetRefusals: counter(row.budget_refusals, `${path}.budget_refusals`),
    aiCalls: counter(row.ai_calls, `${path}.ai_calls`),
    lastActivityAt: optionalStr(row.last_activity_at, `${path}.last_activity_at`),
  };
}

/**
 * Parse the platform API's `/v1/kora/ai-metrics` `data` object.
 *
 * `window`, `outcomes` and `users` are all required — a response missing any
 * of them is a contract deviation, not an empty surface. `first_try_rate_pct`
 * inside `outcomes` and `last_activity_at` inside each user row are the two
 * genuinely optional fields; see their own doc comments.
 */
export function parseKoraAiMetrics(json: unknown): KoraAiMetrics {
  const body = obj(json, "response");

  if (!Array.isArray(body.users)) fail("users is not an array");

  return {
    window: parseWindow(body.window, "window"),
    outcomes: parseOutcomes(body.outcomes, "outcomes"),
    users: body.users.map((row, i) => parseUser(row, `users[${i}]`)),
  };
}

/**
 * Parse the SAME response's `meta` object — NOT a `pagination` sibling
 * inside `data`. `WriteMeta` (`platform-api/internal/platform/httpx/response.go`)
 * puts pagination in the envelope's top-level `meta`, alongside `data`, not
 * inside it — see `platformRequestWithMeta`, which is what the caller must
 * use to reach it at all; `platformRequest` discards `meta` before this
 * function would ever see it.
 *
 * `meta` carries `total` and `limit` only. `page` is NOT read from it —
 * `metaFrom` (`koraaimetrics/internal/handler/handler.go`) deliberately never
 * emits one: `httpx.Meta` is cursor-oriented and has no page field, and page
 * is the one value the caller already supplied, so it is taken here as an
 * argument instead of being re-derived from a wire value that does not exist.
 *
 * Kept as its own function rather than folded into `parseKoraAiMetrics`
 * because the two calling surfaces want different shapes: the `/kora`
 * overview only ever reads page one and has nowhere to put a pager, while
 * `/kora/ai-metrics` needs both the metrics AND where this page sits in the
 * user list. Both functions read the one response; neither re-derives the
 * other's fields.
 */
export function parseKoraAiMetricsPagination(meta: unknown, page: number): EntityPagination {
  const body = obj(meta, "meta");
  return {
    page,
    limit: counter(body.limit, "meta.limit"),
    total: counter(body.total, "meta.total"),
  };
}
