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
