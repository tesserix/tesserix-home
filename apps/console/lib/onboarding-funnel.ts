// `PlatformApiError` from HERE, not from `./platform-api`: this module is
// imported (as a type) by a client component, and the class is a VALUE, so
// importing it from `platform-api.ts` would rope `pg` into the browser bundle.
// See `platform-api-error.ts`'s own header.
import { PlatformApiError } from "./platform-api-error";

/**
 * One product's onboarding funnel — `GET /v1/onboarding/funnel?source=…`.
 *
 * # Why the stages are a LIST and not named fields
 *
 * platform-api's `onboardingfunnel` module forwards mark8ly's `data` object
 * unparsed (`json.RawMessage`), on purpose: tesserix-home#404's first rule is
 * that the product's own stage vocabulary is rendered verbatim, because a
 * console-side enumeration of funnel stages is a second vocabulary that
 * drifts from the first. Five named fields here — `started`, `emailVerified`,
 * … — would BE that second vocabulary, and the day mark8ly adds a sixth stage
 * this console would drop it silently and show a funnel that no longer adds
 * up.
 *
 * So every counter mark8ly sends becomes a `FunnelStage` carrying the
 * product's own key, in the order the product sent it. Nothing is renamed,
 * reordered, or dropped, and a stage this build has never heard of renders
 * exactly like the five it has. The only console-side transform is
 * presentational (`stageLabel` in the view), which is reversible by eye.
 *
 * # Why "could not read" can never wear the clothes of zero
 *
 * #404's second rule: "a stage with zero is a measurement; a funnel that
 * could not be read is not". This parser THROWS rather than returning a
 * degraded funnel — a thrown read reaches the page as a `SurfaceState` that
 * is not `ready`, while a zeroed funnel would render as "nobody signed up".
 * Two shapes in particular are refused for exactly that reason: a funnel with
 * no counters at all, and a funnel whose `median_completion_seconds` key is
 * absent (see {@link parseMedian}).
 */

/** One counter, named as the product names it. */
export interface FunnelStage {
  /** mark8ly's own key — `started`, `email_verified`, … — never translated. */
  readonly stage: string;
  readonly count: number;
}

/**
 * The live pulse: the last 24 hours.
 *
 * TWO fields, and deliberately not the five a stage list carries. mark8ly
 * projects this through a `last24hRow` that is narrower than its counter row
 * on purpose ("the contract pins only started/completed for the live pulse"),
 * so a shape with five keys here would print three zeroes the product never
 * measured — the same phantom-measurement failure the rest of this module
 * exists to prevent, just pointing the other way.
 */
export interface OnboardingPulse {
  readonly started: number;
  readonly completed: number;
}

/** The window mark8ly actually applied, echoed back. */
export interface OnboardingWindow {
  readonly from: string;
  readonly to: string;
}

export interface OnboardingFunnel {
  /** Every counter the product sent, in the product's own order. */
  readonly stages: readonly FunnelStage[];
  /**
   * `null` means NOT MEASURABLE — no session completed in the window, so
   * there is no median. It is not zero, and no caller may default it to zero:
   * `?? 0` here renders "instant completion" for a funnel nobody finished.
   */
  readonly medianCompletionSeconds: number | null;
  readonly last24h: OnboardingPulse;
  readonly window: OnboardingWindow;
}

/**
 * The keys that are structure rather than stages. Everything else in the
 * object is a counter — which is what lets an unknown stage through.
 */
const STRUCTURAL_KEYS: readonly string[] = [
  "median_completion_seconds",
  "last_24h",
  "window",
];

function fail(message: string): never {
  throw new PlatformApiError(`onboarding funnel: ${message}`);
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

function counter(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${path} is not a non-negative whole number`);
  }
  return value;
}

/**
 * The median, whose ABSENCE is the one shape this parser will not accept.
 *
 * `null` is a real, representable answer and passes through untouched. A
 * missing key is not: it collapses "not measurable" into whatever the reader
 * defaults to, and every plausible default is a lie. mark8ly declares the
 * field with no `omitempty` and platform-api refuses a body without it, so
 * reaching this branch means something upstream broke the contract — which is
 * a failed read, not a fast funnel.
 */
function parseMedian(row: Record<string, unknown>): number | null {
  if (!("median_completion_seconds" in row)) {
    fail("median_completion_seconds is absent — an absent median is not zero");
  }
  const value = row.median_completion_seconds;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("median_completion_seconds is neither null nor a non-negative number");
  }
  return value;
}

function parsePulse(value: unknown): OnboardingPulse {
  const row = obj(value, "last_24h");
  return {
    started: counter(row.started, "last_24h.started"),
    completed: counter(row.completed, "last_24h.completed"),
  };
}

function parseWindow(value: unknown): OnboardingWindow {
  const row = obj(value, "window");
  return { from: str(row.from, "window.from"), to: str(row.to, "window.to") };
}

/**
 * Every counter on the funnel root, in wire order.
 *
 * `Object.entries` preserves the JSON's own key order for non-numeric keys,
 * so "the order mark8ly sent them" survives the round trip and the funnel
 * reads top to bottom the way the product describes it.
 *
 * A non-numeric key that is not one of the structural three is skipped rather
 * than refused. It is not a stage — a future `sources` object or a string tag
 * is not a counter this surface can render — and refusing the whole funnel
 * over an additive field would turn a perfectly readable funnel into an
 * unreadable one, which is the opposite of what #404's second rule asks for.
 * A numeric key IS a counter, so an unknown one is rendered, never dropped.
 */
function parseStages(row: Record<string, unknown>): readonly FunnelStage[] {
  const stages: FunnelStage[] = [];
  for (const [stage, value] of Object.entries(row)) {
    if (STRUCTURAL_KEYS.includes(stage)) continue;
    if (typeof value !== "number") continue;
    stages.push({ stage, count: counter(value, stage) });
  }
  if (stages.length === 0) {
    fail("the funnel carries no stage counters — that is indistinguishable from zeroes");
  }
  return stages;
}

/** Parse the platform API's `/v1/onboarding/funnel` `data` object. */
export function parseOnboardingFunnel(json: unknown): OnboardingFunnel {
  const row = obj(json, "response");
  return {
    stages: parseStages(row),
    medianCompletionSeconds: parseMedian(row),
    last24h: parsePulse(row.last_24h),
    window: parseWindow(row.window),
  };
}
