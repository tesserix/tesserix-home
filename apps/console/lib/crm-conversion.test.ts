import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConversionSignal } from "./crm-conversion";

afterEach(() => {
  vi.unstubAllGlobals();
});

const VALID_COMPLETE = {
  state: "complete",
  ref: "tenant_9f2",
  label: "Bondi Store",
  observed_at: "2026-08-17T09:00:00.000Z",
};

describe("fetchConversionSignal", () => {
  // THE assertion that matters. A false `none` under-reports the funnel and
  // leaves a live merchant sitting in the handoff queue as though they had
  // stalled. Ruling 27: apps/web answers 501 for a product it has no
  // conversion-status adapter for yet, which is indistinguishable — by design
  // — from "we have never heard of this product".
  it("maps 501 to unknown, never none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 501 }));
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  it("maps an unreachable product (apps/web itself unreachable) to unknown, not none", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  // Ruling 28: 404 can no longer carry "no conversion concept" — it is also
  // what this exact route returns when apps/web's endpoint does not exist at
  // all, which is true for every product today. A meaning chosen for "the
  // product answered" cannot also be the framework's own answer for "there is
  // no route here"; the two are indistinguishable on the wire. Only an
  // explicit 200 can produce a definite state.
  it("maps 404 to unknown — indistinguishable from the route not existing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  // The definite path stays pinned: a product that wants to assert "not
  // converted" does so honestly, by answering 200 with `{ state: "none" }`.
  it("maps a 200 body of { state: \"none\" } to none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ state: "none", observed_at: "2026-08-17T09:00:00.000Z" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("none");
  });

  it("maps any other non-2xx (a real transport/upstream error) to unknown, not none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  it("parses a valid 200 body and carries ref only alongside the product", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_COMPLETE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("mark8ly", "a@b.com", "tx_session=abc");
    expect(signal).toEqual({
      product: "mark8ly",
      state: "complete",
      ref: "tenant_9f2",
      label: "Bondi Store",
      idleHours: undefined,
      observedAt: "2026-08-17T09:00:00.000Z",
    });
  });

  it("maps a malformed 200 body (missing observed_at) to unknown, not none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ state: "none" /* observed_at missing */ }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  it("maps a 200 body with an unrecognised state string to unknown, not none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ state: "sort-of", observed_at: "2026-08-17T09:00:00.000Z" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  // Distinct branch from "malformed body": here `response.json()` itself
  // rejects (empty body, non-JSON text), never reaching `parseConversionBody`
  // at all. Must land in the same `unknown` outcome as every other failure.
  it("maps a 200 response whose body is not valid JSON to unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  // Pins the snake_case → camelCase mapping WITH a value present — a
  // mis-keyed `idle_hours`/`idleHours` would pass every other test silently,
  // since the only prior assertion on this field was `idleHours: undefined`.
  it("carries idle_hours through as idleHours when the product reports one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "in_flight",
          idle_hours: 46,
          observed_at: "2026-08-17T09:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("in_flight");
    expect(signal.idleHours).toBe(46);
  });

  // Ruling 29: Node's `fetch` has no default timeout — a request that never
  // resolves is neither `unknown` nor an error, it is a stuck server render,
  // and Task 10 fans this call out per lead in the handoff queue. The bound
  // must be visible on every request, not just the ones that happen to time
  // out in a given test run.
  it("bounds every request with an AbortSignal so a hung apps/web cannot hang forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_COMPLETE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchConversionSignal("mark8ly", "a@b.com", "tx_session=abc");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // The signal firing is a rejection like any other transport failure, and
  // must land in the same `unknown` branch — not escape as an unhandled
  // rejection, and not leave the caller waiting indefinitely.
  it("maps a timed-out (aborted) request to unknown, not none", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted.", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const signal = await fetchConversionSignal("kora", "a@b.com", "tx_session=abc");
    expect(signal.state).toBe("unknown");
  });

  it("calls apps/web's per-product conversion-status route, not the product directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_COMPLETE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchConversionSignal("mark8ly", "a@b.com", "tx_session=abc");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/admin/apps/mark8ly/conversion-status");
    expect(url).toContain("email=a%40b.com");
    expect(new Headers(init.headers).get("cookie")).toBe("tx_session=abc");
  });
});
