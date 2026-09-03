import { describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED, resolveState } from "@/components/kit/surface-state";
import { PlatformApiError } from "./platform-api-error";
import {
  KPIS_UNAVAILABLE_MESSAGE,
  KPIS_UNAVAILABLE_TITLE,
  kpisReadError,
  parseProductKpis,
} from "./kpis";

/**
 * The shape a parser here actually receives.
 *
 * NOT `{ data: { … } }`: the kpis handler passes the metrics map straight to
 * `httpx.WriteData`, and `platformRequest` unwraps the `StandardResponse`
 * envelope before calling any parser. §8.6's `data` wrapper is checked one hop
 * earlier, by `service.go`, on the PRODUCT's response — see this module's
 * header.
 */
const METRICS = {
  orders_today: 128,
  gmv_inr: 4_210_500.5,
  // A string and a bool beside the numbers: `Metrics` is `map[string]any` on
  // purpose, and narrowing to number would drop a metric the product meant to
  // send.
  payments_health: "healthy",
  dunning_active: true,
};

function stateFor(caught: unknown) {
  return resolveState({
    isLoading: false,
    error: kpisReadError(caught),
    rows: [1],
    filtered: false,
  });
}

describe("parseProductKpis", () => {
  it("reads a flat map of arbitrary keys, including a string and a bool", () => {
    expect(parseProductKpis(METRICS)).toEqual(METRICS);
  });

  it("returns a new object rather than the argument", () => {
    const parsed = parseProductKpis(METRICS);
    expect(parsed).not.toBe(METRICS);
  });

  it("refuses a double-wrapped body via the scalar rule, not a `data` check", () => {
    // Named for what actually bites. There is NO `data`-wrapper check in
    // `kpis.ts`: this body is refused because the value under `data` is an
    // object, which `scalar` rejects like any other non-scalar. The earlier
    // name for this test claimed a mechanism that does not exist.
    //
    // No explicit `data` check was added, deliberately: `data` is a legal
    // metric key. A product reporting a scalar named `data` is within §3.1,
    // and a check keyed on the name would refuse a valid map to catch a
    // shape the scalar rule already catches.
    expect(() => parseProductKpis({ data: METRICS })).toThrow(PlatformApiError);
  });

  it("refuses a body that is not an object at all", () => {
    expect(() => parseProductKpis(null)).toThrow(/not an object/);
    expect(() => parseProductKpis([])).toThrow(/not an object/);
    expect(() => parseProductKpis("healthy")).toThrow(/not an object/);
  });

  it("refuses an empty map as a decode error, NOT as not-instrumented", () => {
    // §3.1 requires 501 rather than `{}`, because `{}` is indistinguishable
    // from every metric being zero. Reporting it as "not instrumented" would
    // hide a deviating product behind a legitimate-looking answer, so it has
    // to throw — and the thrown error carries no 501, so it can never resolve
    // to the calm state.
    let caught: unknown;
    try {
      parseProductKpis({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).message).toMatch(/empty/);
    expect(stateFor(caught)).toMatchObject({ kind: "error" });
    expect(stateFor(caught)).not.toMatchObject({ kind: "instrumentation-unavailable" });
  });

  it("refuses a non-scalar value rather than carrying it to the page", () => {
    expect(() => parseProductKpis({ ...METRICS, orders_today: null })).toThrow(/orders_today/);
    expect(() => parseProductKpis({ ...METRICS, orders_today: { value: 1 } })).toThrow(
      /orders_today/,
    );
    expect(() => parseProductKpis({ ...METRICS, orders_today: [1, 2] })).toThrow(/orders_today/);
  });
});

describe("kpisReadError", () => {
  it("resolves a 501 to instrumentation-unavailable carrying this surface's copy", () => {
    const notInstrumented = Object.assign(
      new Error("kpis: NOT_IMPLEMENTED — the product reports no headline metrics yet"),
      { status: NOT_IMPLEMENTED },
    );

    expect(stateFor(notInstrumented)).toEqual({
      kind: "instrumentation-unavailable",
      title: KPIS_UNAVAILABLE_TITLE,
      message: KPIS_UNAVAILABLE_MESSAGE,
    });
  });

  it("never sends the operator to the parked-observability copy", () => {
    // The trap this constant exists for: the kit's default 501 message names
    // the observability data plane and `docs/observability-park.md`, which is
    // right for a parked metrics plane and wrong for a product that simply
    // reports no business KPIs.
    expect(KPIS_UNAVAILABLE_MESSAGE).not.toMatch(/observability/i);
    expect(KPIS_UNAVAILABLE_MESSAGE).not.toMatch(/parked/i);
    expect(KPIS_UNAVAILABLE_MESSAGE).not.toMatch(/docs\//);
    expect(KPIS_UNAVAILABLE_TITLE).not.toMatch(/observability/i);
  });

  it("is true of both 501 causes, not just the uninstrumented product", () => {
    // `ErrNoProducts` reaches this surface as well: `service.Read` returns it
    // from `len(s.slugs) == 0` before it looks at `source` at all, and
    // `main.go` fills those slugs from `FEDERATION_PRODUCTS`. So a deployment
    // federating nothing 501s for every product, including one the console's
    // registry knows. Copy naming only the product's side would tell an
    // operator to wait on a product when the fix is an env var.
    expect(KPIS_UNAVAILABLE_MESSAGE).toMatch(/does not report them yet/);
    expect(KPIS_UNAVAILABLE_MESSAGE).toMatch(/federating/);
  });

  it("does not imply breakage or invite a retry", () => {
    expect(KPIS_UNAVAILABLE_MESSAGE).not.toMatch(/Try again/i);
    expect(KPIS_UNAVAILABLE_MESSAGE).not.toMatch(/failed|error|unavailable/i);
  });

  it("leaves a 503 as an error — the dangerous direction", () => {
    // platform-api answers 503 when the product could not be reached at all.
    // Rendering that as "no metrics" tells an operator a number does not exist
    // when it exists and is unreachable, which `writeReadError` calls the more
    // dangerous of the two mistakes.
    //
    // HALF A GUARD ON ITS OWN. The `error` outcome here is enforced by
    // `resolveState`, which this surface does not own — this assertion would
    // still pass if `kpisReadError` were deleted. The removal-sensitive half
    // is "preserves a 503 as a distinct status" in `platform-api.test.ts`,
    // which fails if the status stops reaching this function at all. The
    // 501/503 split is covered by the PAIR; deleting either one leaves a gap
    // the other does not fill.
    const unreachable = Object.assign(
      new Error("kpis: SERVICE_UNAVAILABLE — the product could not be reached"),
      { status: 503 },
    );

    const state = stateFor(unreachable);
    expect(state.kind).toBe("error");
    expect(state.kind).not.toBe("instrumentation-unavailable");
  });

  it("leaves the reauth marker alone", () => {
    // A session with no operator token row is neither of the two states above,
    // and `resolveState` reads that marker ahead of the status.
    const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
    expect(stateFor(noToken)).toEqual({ kind: "reauth-required" });
  });

  it("returns null when nothing was caught", () => {
    expect(kpisReadError(null)).toBeNull();
    expect(kpisReadError(undefined)).toBeNull();
  });
});
