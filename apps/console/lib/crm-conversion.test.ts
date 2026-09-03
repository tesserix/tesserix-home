import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "./platform-api-error";

// The collaborator, not `fetch`. This module's contract is "whatever
// platform-api answers or fails with, produce a signal that never fabricates
// `none`" — so the layer to fake is the one that produces those outcomes.
// Faking `fetch` instead would also drag in token resolution and the envelope
// unwrap, and would pin how `platformRequestWithMeta` is implemented rather
// than what this module promises.
const platformRequestWithMeta = vi.fn();
vi.mock("./platform-api", () => ({
  platformRequestWithMeta: (...args: unknown[]) => platformRequestWithMeta(...args),
}));

const { fetchConversionSignal } = await import("./crm-conversion");

const VALID_COMPLETE = {
  state: "complete",
  ref: "tenant_9f2",
  label: "Bondi Store",
  observed_at: "2026-08-17T09:00:00.000Z",
};

/** platform-api answered 200; `data` is the product's body, forwarded. */
function answers(data: unknown) {
  platformRequestWithMeta.mockResolvedValue({ data, meta: undefined });
}

beforeEach(() => {
  platformRequestWithMeta.mockReset();
});

describe("fetchConversionSignal", () => {
  // THE assertion that matters, and the reason this module exists. A false
  // `none` under-reports the funnel and leaves a live merchant sitting in the
  // handoff queue as though they had stalled.
  //
  // Ruling 28, restated for the platform-api road: every one of these is a
  // thrown PlatformApiError, and every one means "we did not find out".
  it.each([
    ["501 — no product declares conversions", new PlatformApiError("not implemented", 501)],
    ["501 — the product declares and declines", new PlatformApiError("not implemented", 501)],
    ["404 — declared but not mounted", new PlatformApiError("not found", 404)],
    ["503 — the product could not be reached", new PlatformApiError("unavailable", 503)],
    ["400 — the product cannot be asked", new PlatformApiError("bad request", 400)],
    ["502 — something upstream", new PlatformApiError("bad gateway", 502)],
    ["platform-api itself unreachable", new PlatformApiError("request failed (ECONNREFUSED)")],
    ["no origin configured", new PlatformApiError("the platform API origin is not configured")],
    ["this session carries no token", new PlatformApiError("no token", undefined, {
      noOperatorToken: true,
    })],
    ["a timed-out request", new DOMException("The operation was aborted.", "TimeoutError")],
  ])("maps %s to unknown, never none", async (_name, failure) => {
    platformRequestWithMeta.mockRejectedValue(failure);

    const signal = await fetchConversionSignal("mark8ly", "a@b.com");

    expect(signal.state).toBe("unknown");
    // `unknown` carries no timestamp: there was never a trustworthy body to
    // read one off, and a present observedAt would make it look measured.
    expect(signal.observedAt).toBeUndefined();
  });

  // The definite path stays pinned: a product that wants to assert "not
  // converted" does so honestly, by answering 200 with `{ state: "none" }`.
  it("maps a body of { state: \"none\" } to none", async () => {
    answers({ state: "none", observed_at: "2026-08-17T09:00:00.000Z" });

    const signal = await fetchConversionSignal("mark8ly", "a@b.com");
    expect(signal.state).toBe("none");
  });

  it("parses a valid body and carries ref only alongside the product", async () => {
    answers(VALID_COMPLETE);

    const signal = await fetchConversionSignal("mark8ly", "a@b.com");
    expect(signal).toEqual({
      product: "mark8ly",
      state: "complete",
      ref: "tenant_9f2",
      label: "Bondi Store",
      idleHours: undefined,
      observedAt: "2026-08-17T09:00:00.000Z",
    });
  });

  // Pins the snake_case → camelCase mapping WITH a value present — a mis-keyed
  // `idle_hours`/`idleHours` would pass every other test silently, since the
  // only other assertion on this field is `idleHours: undefined`.
  it("carries idle_hours through as idleHours when the product reports one", async () => {
    answers({ state: "in_flight", idle_hours: 46, observed_at: "2026-08-17T09:00:00.000Z" });

    const signal = await fetchConversionSignal("mark8ly", "a@b.com");
    expect(signal.state).toBe("in_flight");
    expect(signal.idleHours).toBe(46);
  });

  // A 200 that platform-api forwarded but this side cannot read is not `none`:
  // the contract was violated, so there is no trustworthy answer to coerce a
  // default out of. platform-api refuses most of these itself; this side does
  // not rely on that, because "the proxy checks it" is not a guarantee this
  // module can make about its own output.
  it.each([
    ["observed_at is missing", { state: "none" }],
    ["the state is invented", { state: "sort-of", observed_at: "2026-08-17T09:00:00.000Z" }],
    ["there is no state at all", { observed_at: "2026-08-17T09:00:00.000Z" }],
    ["the body is not an object", ["complete"]],
    ["the body is a string", "complete"],
    ["the body is null", null],
    ["ref is not a string", { state: "complete", ref: 7, observed_at: "2026-08-17T09:00:00.000Z" }],
    ["idle_hours is not finite", {
      state: "in_flight", idle_hours: Number.POSITIVE_INFINITY,
      observed_at: "2026-08-17T09:00:00.000Z",
    }],
  ])("maps a body where %s to unknown, not none", async (_name, data) => {
    answers(data);

    const signal = await fetchConversionSignal("mark8ly", "a@b.com");
    expect(signal.state).toBe("unknown");
  });

  it("asks platform-api for the named product and email", async () => {
    answers(VALID_COMPLETE);

    await fetchConversionSignal("mark8ly", "a+tag@b.com");

    const [label, path] = platformRequestWithMeta.mock.calls[0] as [string, string];
    expect(label).toBe("conversion-status");
    // Encoded, not concatenated: a `+` in an address is a real character that
    // a bare query string turns into a space, which would ask about a
    // different person and answer confidently about them.
    expect(path).toBe("/v1/conversions?source=mark8ly&email=a%2Btag%40b.com");
  });

  // Ruling 29: the request is now a proxy of a proxy of a proxy, and Task 10
  // fans it out once per row in the handoff queue. The bound must be on every
  // request, not just the ones that happen to time out in a given run.
  it("bounds every request with an AbortSignal so a hung upstream cannot hang forever", async () => {
    answers(VALID_COMPLETE);

    await fetchConversionSignal("mark8ly", "a@b.com");

    const [, , init] = platformRequestWithMeta.mock.calls[0] as [string, string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // It no longer takes a cookie header: platformRequestWithMeta resolves the
  // operator's own platform API token. Pinned because a caller passing a
  // cookie would now be silently ignored rather than rejected.
  it("takes no cookie header", () => {
    expect(fetchConversionSignal.length).toBe(2);
  });
});
