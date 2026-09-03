/**
 * The conversion-status contract client (#153).
 *
 * A deliverable of the CRM design's "Lead → conversion" section
 * (`docs/superpowers/specs/2026-08-17-crm-design.md`): once an opportunity
 * reaches `stage = won`, the CRM does not read a product's tables to find out
 * whether the agreement actually turned into a live tenant/account/facility.
 * It asks:
 *
 *   GET {platform_api}/v1/conversions?source=<product>&email=<email>
 *   200 { state: "none" | "in_flight" | "complete", ref?, label?,
 *         idle_hours?, observed_at }
 *   anything other than a valid 200 (404, 501, 503, unreachable, timeout)
 *     → unknown
 *
 * platform-api forwards the product's answer byte for byte and adds nothing to
 * it, so the wire shape below is mark8ly's own — see
 * platform-api/internal/modules/conversions, which argues why a Go struct
 * there would be a second reader of this same contract.
 *
 * WHO IS ASKED CHANGED IN #246; WHAT AN ANSWER MEANS DID NOT. This client
 * targeted apps/web until then, under Ruling 27. See the note above
 * `fetchConversionSignal` for why that ruling no longer holds and what
 * replaced it.
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

import { PlatformApiError } from "./platform-api-error";
import { platformRequestWithMeta } from "./platform-api";

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
  /**
   * Null only on the one signal nobody asked a product for: a migrated
   * opportunity carries no product (see `HandoffRow.product`), so there is
   * no admin API to address the question to. `fetchConversionSignal` itself
   * still requires a real product — a null here can only ever accompany
   * `state: "unknown"`, never a definite answer, because a definite answer
   * can only come from a product that was actually asked.
   */
  readonly product: string | null;
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

// RULING 27 IS SUPERSEDED, AND THIS IS THE ROUTE THAT SUPERSEDES IT (#246).
//
// The ruling sent every cross-product read through apps/web, "which holds the
// HMAC keys Kora and Fe3dr require — moving those keys into the console would
// be a secret-distribution change, not a refactor."
//
// Both halves of that stopped being true for this read:
//
//  - apps/web holds Kora's, Homechef's and Otto's credentials and NO mark8ly
//    credential. The `company` deployment carries MARK8LY_PLATFORM_API_URL and
//    nothing to sign with, so honouring the ruling here would have MEANT the
//    secret distribution it exists to avoid — into a second workload.
//  - apps/web is being retired to a marketing page. A tenth admin proxy route
//    there is work with a known expiry.
//
// platform-api already federates to the product that answers this, with the
// signed envelope mark8ly's platformadmin middleware requires
// (FEDERATION_MARK8LY_*). So the console asks platform-api, which is where
// every cross-product read is going anyway.
//
// What did NOT change is everything below: the strict parser, Ruling 28's
// "only an explicit 200 is definite", and Ruling 29's timeout. Those are about
// what an answer means, not about who is asked.

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
 * does not, such as platform-api being unreachable or this session carrying no
 * platform API token — resolves to a `ConversionSignal` whose `state` is
 * `"unknown"`, so a caller building the handoff queue never has to
 * special-case a rejected promise to stay safe.
 *
 * It takes no cookie header. It used to, because apps/web authenticated the
 * console by session cookie; `platformRequestWithMeta` resolves the operator's
 * own platform API token instead, so a caller has nothing to pass and cannot
 * pass the wrong thing.
 */
export async function fetchConversionSignal(
  product: string,
  email: string,
): Promise<ConversionSignal> {
  const unknown = (): ConversionSignal => ({ product, state: "unknown" });

  // `platformRequestWithMeta`, not a bare fetch: it resolves the operator's
  // platform API token, sets the bearer header and unwraps the estate
  // envelope. Every failure it can produce — an unset origin, no token, a
  // transport error, a non-2xx, an envelope carrying `success: false` — is a
  // thrown `PlatformApiError`, and every one of them means the same thing
  // here: we did not find out.
  let data: unknown;
  try {
    ({ data } = await platformRequestWithMeta(
      "conversion-status",
      `/v1/conversions?source=${encodeURIComponent(product)}&email=${encodeURIComponent(email)}`,
      {
        // RULING 29 still applies, and applies MORE now: the request is a
        // proxy of a proxy of a proxy (console → platform-api → mark8ly), and
        // Task 10 fans it out once per row in the handoff queue. A hung
        // upstream anywhere on that chain must resolve to `unknown`, not stall
        // a server render. `platformRequestWithMeta` spreads this init into
        // its own fetch, so the abort lands in its catch and arrives here as
        // a PlatformApiError like any other failure.
        signal: AbortSignal.timeout(CONVERSION_STATUS_TIMEOUT_MS),
      },
    ));
  } catch {
    // RULING 28, unchanged in substance: 404 ("no route"), 501 ("the product
    // declares none"), 503 ("could not be read"), an unreachable platform-api,
    // a timed-out AbortSignal — all collapse to `unknown`. A product asserting
    // "not converted" does so the one honest way, by answering
    // `200 { state: "none" }`, which reaches the `data` below.
    return unknown();
  }

  let body: ConversionResponseBody;
  try {
    body = parseConversionBody(data);
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
