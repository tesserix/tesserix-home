/**
 * The conversion-status contract client (#153).
 *
 * A deliverable of the CRM design's "Lead → conversion" section
 * (`docs/superpowers/specs/2026-08-17-crm-design.md`): once an opportunity
 * reaches `stage = won`, the CRM does not read a product's tables to find out
 * whether the agreement actually turned into a live tenant/account/facility.
 * It asks, over the same per-product admin API road HMAC-signing already
 * uses for Kora and Fe3dr:
 *
 *   GET {product_admin_api}/internal/conversion-status?email=<email>
 *   200 { state: "none" | "in_flight" | "complete", ref?, label?,
 *         idle_hours?, observed_at }
 *   anything other than a valid 200 (404, 501, unreachable, timeout) → unknown
 *
 * RULING 27 (binding, #153): the console never calls a product's admin API
 * directly, and does not hold a product → base-URL registry. Every other
 * cross-product read in this codebase (`platform-api.ts`'s tickets, support
 * analytics, audit log) goes through `apps/web`, which holds the HMAC keys
 * Kora and Fe3dr require — moving those keys into the console would be a
 * secret-distribution change, not a refactor. So this client targets
 * `{WEB_ORIGIN}/api/admin/apps/{product}/conversion-status?email=…`,
 * following `platform-api.ts`'s existing shape.
 *
 * That collapses "no registry entry for this product" and "apps/web has no
 * adapter for this product yet" into ONE code path: apps/web answers 501 for
 * both, and 501 already maps to `unknown`. There is nothing here that can
 * drift out of sync with `ESTATE` because there is no second list to drift.
 *
 * NOTE: `apps/web`'s `/api/admin/apps/[product]/conversion-status` endpoint
 * does not exist yet — it is the next piece, not part of this task. This
 * client is exercised entirely against a mocked `fetch`. Every response it
 * has not yet been taught to expect (including "route not found") arrives as
 * a non-2xx status and is handled by the same 501/other-failure path as a
 * genuinely unimplemented product, which is the correct, honest behaviour
 * for a client stood up ahead of its server.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (RULING 28):
 *
 * Only an explicit 200 with a valid body produces a definite state. A 404, a
 * 501, an unreachable apps/web, a timeout, any other transport failure, or a
 * 200 body that does not parse — ALL map to `unknown`, NEVER to `none`.
 * `none` means "the product answered, and this person has not converted".
 * `unknown` means "we could not find out". Collapsing the two under-reports
 * the funnel and, worse, leaves a merchant who is actually live sitting in
 * the handoff queue looking like they stalled.
 *
 * 404 does NOT map to `none`. The original design let it: "the product has
 * no conversion concept" reads like a real answer. But 404 is also exactly
 * what this route returns when apps/web's endpoint does not exist at all —
 * true of every product before its adapter ships — and the two are
 * indistinguishable on the wire. A meaning chosen for "the product answered"
 * cannot also be the framework's own answer for "there is no route here". A
 * product that wants to assert "not converted" does so honestly, by
 * answering `200 { state: "none" }`.
 *
 * The product's answer may only ever ADD a conversion, never remove one:
 * nothing in this module reads or clears `stage = won`, which stays the
 * CRM's own authority over the agreement. This module only ever produces a
 * `ConversionSignal` for a caller to read; it has no write path at all.
 */

import { PlatformApiError } from "./platform-api";

/**
 * `"unknown"` is a fourth state the wire contract does not have — it exists
 * only on this side, for "we asked and could not get a trustworthy answer".
 * The other three are the product's own vocabulary, carried through
 * unchanged.
 */
export type ConversionState = "unknown" | "none" | "in_flight" | "complete";

/**
 * The result of asking one product about one email.
 *
 * `product` travels WITH `ref` always, by construction — there is no
 * accessor here that returns `ref` on its own. `ref` is opaque and
 * product-scoped (a tenant id and a facility id are only meaningful together
 * with whose namespace they are in), so a bare `ref` string, on its own,
 * mismatches the design's rule #3 the moment a caller forwards it without
 * `product` alongside.
 */
export interface ConversionSignal {
  readonly product: string;
  readonly state: ConversionState;
  readonly ref?: string;
  readonly label?: string;
  readonly idleHours?: number;
  /**
   * When the product's answer was produced. Present only for a definite
   * state (`none` / `in_flight` / `complete`), all of which are reached
   * exclusively through a valid 200 body that carries this field. Absent for
   * `unknown` — there was never a trustworthy body to read a timestamp off.
   */
  readonly observedAt?: string;
}

/** The contract's own three states — never `"unknown"`, which this side adds. */
const WIRE_STATES = ["none", "in_flight", "complete"] as const;
type WireState = (typeof WIRE_STATES)[number];

function isWireState(value: unknown): value is WireState {
  return (
    typeof value === "string" &&
    (WIRE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Everything read off a 200 body, before it becomes a `ConversionSignal`.
 */
interface ConversionResponseBody {
  readonly state: WireState;
  readonly ref?: string;
  readonly label?: string;
  readonly idleHours?: number;
  readonly observedAt: string;
}

/**
 * Parse the contract's 200 body — strictly, `lib/tickets.ts`-style: reject a
 * body that does not match rather than coerce a missing or misshapen field
 * into a default that would read as a real answer.
 *
 * `observed_at` is REQUIRED, per the contract, even though this side never
 * surfaces it for `none`/`unknown` reached other ways. A 200 body missing it
 * is not "the product forgot a decoration field" — it is a 200 the product's
 * own contract says should not exist, and the honest read of "the contract
 * was violated" is the same as "no trustworthy answer arrived": `unknown`,
 * not a fabricated default that would let a malformed body read as `none`.
 *
 * Throws on any deviation; the caller (`fetchConversionSignal`) is what
 * decides a parse failure becomes `unknown` rather than propagating as an
 * uncaught error — this function itself makes no such decision, so it stays
 * reusable anywhere a strict read of the contract is needed.
 */
export function parseConversionBody(json: unknown): ConversionResponseBody {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new PlatformApiError("conversion-status: response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!isWireState(body.state)) {
    throw new PlatformApiError(
      `conversion-status: state is not one of ${WIRE_STATES.join(", ")}`,
    );
  }
  if (typeof body.observed_at !== "string" || body.observed_at === "") {
    throw new PlatformApiError("conversion-status: observed_at is missing");
  }
  if (body.ref !== undefined && typeof body.ref !== "string") {
    throw new PlatformApiError("conversion-status: ref is not a string");
  }
  if (body.label !== undefined && typeof body.label !== "string") {
    throw new PlatformApiError("conversion-status: label is not a string");
  }
  // A separate `let` + narrowed assignment, rather than the compound
  // condition inlined at the return: the compiler cannot carry a narrowing
  // through `a !== undefined && (typeof a !== "x" || !check(a))` back out to
  // a later `return` expression, and the alternative is asserting the type
  // with `as` — telling the compiler rather than letting the guard prove it,
  // the one place this otherwise cast-free parser would have done that.
  let idleHours: number | undefined;
  if (body.idle_hours !== undefined) {
    if (typeof body.idle_hours !== "number" || !Number.isFinite(body.idle_hours)) {
      throw new PlatformApiError("conversion-status: idle_hours is not a number");
    }
    idleHours = body.idle_hours;
  }

  return {
    state: body.state,
    ref: body.ref,
    label: body.label,
    idleHours,
    observedAt: body.observed_at,
  };
}

// Same origin as every other cross-product read in `platform-api.ts` — the
// console never talks to a product directly, only ever to apps/web.
const WEB_ORIGIN = process.env.WEB_INTERNAL_ORIGIN ?? "http://localhost:3002";

/**
 * RULING 29. Node's `fetch` has no default request timeout — an apps/web
 * that accepts the connection and never responds would hang this promise
 * forever, which is neither `unknown` nor a thrown error: it is a stuck
 * server render. That matters more here than anywhere in the console:
 * Task 10 fans this call out once per lead in the handoff queue, so one
 * hung upstream would stall the whole surface, and this is the one module
 * whose entire contract is "a non-answer resolves to `unknown`" — a promise
 * that never resolves breaks that promise (the English kind) outright.
 *
 * 8s, not `platform-api.ts`'s absence of one: apps/web's own upstream calls
 * to Kora/Fe3dr are themselves HMAC-signed HTTP round trips, so this request
 * is a proxy of a proxy. Generous enough that a normally-slow upstream still
 * answers; short enough that a queue rendering several of these in sequence
 * does not itself start to feel stuck.
 *
 * `lib/platform-api.ts` has the same missing-timeout gap and is NOT fixed
 * here — that is estate-wide and out of this task's scope, logged as a
 * follow-up. Fixed in this module specifically because this module's whole
 * reason to exist is the promise that a non-answer becomes `unknown`.
 */
const CONVERSION_STATUS_TIMEOUT_MS = 8_000;

/**
 * Ask apps/web whether `email` has converted for `product`.
 *
 * Never throws: every failure mode this contract defines — and every one it
 * does not, such as apps/web's own route not existing yet — resolves to a
 * `ConversionSignal` whose `state` is `"unknown"`, so a caller building the
 * handoff queue never has to special-case a rejected promise to stay safe.
 * The one exception is a caller-side bug (e.g. missing `cookieHeader`
 * argument), which is a TypeScript error, not a runtime one.
 */
export async function fetchConversionSignal(
  product: string,
  email: string,
  cookieHeader: string,
): Promise<ConversionSignal> {
  const unknown = (): ConversionSignal => ({ product, state: "unknown" });

  let response: Response;
  try {
    response = await fetch(
      `${WEB_ORIGIN}/api/admin/apps/${encodeURIComponent(product)}/conversion-status?email=${encodeURIComponent(email)}`,
      {
        headers: { cookie: cookieHeader },
        cache: "no-store",
        // RULING 29: bounds the request so a hung apps/web cannot hang this
        // promise forever. The resulting `AbortError`/`TimeoutError` is a
        // rejection like any other transport failure, and lands in the same
        // `catch` below — it must never escape as an unhandled rejection or
        // leave the caller waiting indefinitely.
        signal: AbortSignal.timeout(CONVERSION_STATUS_TIMEOUT_MS),
      },
    );
  } catch {
    // Unreachable apps/web, DNS failure, a timed-out AbortSignal — all
    // transport failures, not answers. THE rule: this must never read as
    // "not converted".
    return unknown();
  }

  // RULING 28: 404 ("no conversion concept"), 501 ("not implemented yet"),
  // and every other non-2xx all collapse to `unknown`. The contract's
  // original design let 404 carry a definite `none`, but 404 is also what
  // this exact route returns when it does not exist at all — which is true
  // of every product today, since apps/web's endpoint has not been built
  // yet. A meaning chosen for "the product answered" cannot also be the
  // framework's own answer for "there is no route here"; the two are
  // indistinguishable on the wire, so 404 can never be trusted to mean the
  // first one. "No conversion concept" and "not implemented" are the same
  // fact from the CRM's side anyway — nothing can be learned either way —
  // so both belong in `unknown`. Only an explicit 200 produces a definite
  // state; a product asserting "not converted" does so by answering
  // `200 { state: "none" }`, which is the one honest way to say it.
  if (!response.ok) {
    return unknown();
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return unknown();
  }

  let body: ConversionResponseBody;
  try {
    body = parseConversionBody(json);
  } catch {
    // A malformed 200 is not `none`: the product's contract was violated, so
    // there is no trustworthy answer to coerce a default out of.
    return unknown();
  }

  return {
    product,
    state: body.state,
    ref: body.ref,
    label: body.label,
    idleHours: body.idleHours,
    observedAt: body.observedAt,
  };
}
