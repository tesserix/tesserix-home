import { PlatformApiError } from "./platform-api";

/**
 * Kora's food-resolution accuracy metrics — `GET /v1/kora/ai-metrics`.
 *
 * platform-api's `koraaimetrics` module forwards Kora's `data` object
 * **unparsed** (`json.RawMessage`) — see that module's own doc comment for
 * why (§8.9's cautionary tale: a fixed struct silently drops a field nobody
 * modelled). This console is therefore the first place this shape is
 * modelled at all, and — following that same §8.9 discipline — it models
 * only the fields the overview tile actually renders: `outcomes.attempts`,
 * `outcomes.needs_human`, `outcomes.first_try_rate_pct`. `window` and
 * `users` are real fields on Kora's response (tesserix/kora#507) that this
 * parser deliberately does not touch.
 */

export interface KoraAiOutcomes {
  readonly attempts: number;
  readonly needsHuman: number;
  /**
   * ABSENT, not `0.0`, when the measurement window had no attempts to score
   * — deliberate on Kora's side. Optional here for the same reason: a caller
   * that defaults this to `0` would render a confident, false zero for a
   * window that measured nothing. See `overview-view.tsx`'s
   * `formatFirstTryRate`, which is the one place this is turned into copy.
   */
  readonly firstTryRatePct?: number;
}

export interface KoraAiMetrics {
  readonly outcomes: KoraAiOutcomes;
}

function fail(message: string): never {
  throw new PlatformApiError(`kora ai metrics: ${message}`);
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

/**
 * Parse the platform API's `/v1/kora/ai-metrics` `data` object.
 *
 * `outcomes` is required — a response with no outcomes to show is a contract
 * deviation, not an empty tile. `first_try_rate_pct` inside it is the one
 * genuinely optional field; see `KoraAiOutcomes.firstTryRatePct`.
 */
export function parseKoraAiMetrics(json: unknown): KoraAiMetrics {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  const outcomes = body.outcomes;
  if (typeof outcomes !== "object" || outcomes === null || Array.isArray(outcomes)) {
    fail("outcomes is missing");
  }
  const row = outcomes as Record<string, unknown>;

  return {
    outcomes: {
      attempts: counter(row.attempts, "outcomes.attempts"),
      needsHuman: counter(row.needs_human, "outcomes.needs_human"),
      firstTryRatePct: optionalRate(row.first_try_rate_pct, "outcomes.first_try_rate_pct"),
    },
  };
}
