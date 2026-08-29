import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformApiError } from "./platform-api-error";
import { parseEstateOutbox } from "./outbox";

/** The shape platform-api's outbox module emits — `domain.Page` verbatim. */
const body = {
  events: [
    {
      id: "mark8ly:e1",
      tenant_id: "t1",
      aggregate: "order",
      aggregate_id: "o1",
      event_type: "order.created",
      status: "pending",
      created_at: "2026-08-27T09:00:00Z",
      age_seconds: 42,
      source: "mark8ly",
    },
    {
      id: "kora:e2",
      tenant_id: "t2",
      aggregate: "food",
      aggregate_id: "f1",
      event_type: "food.updated",
      status: "published",
      created_at: "2026-08-27T08:00:00Z",
      published_at: "2026-08-27T08:00:05Z",
      source: "kora",
    },
  ],
  failures: [],
  not_implemented: [],
};

describe("parseEstateOutbox", () => {
  it("reads the platform API's shape, and every row carries its source", () => {
    const page = parseEstateOutbox(body);
    expect(page.events).toHaveLength(2);
    expect(page.events[0]?.source).toBe("mark8ly");
    expect(page.events[1]?.source).toBe("kora");
    expect(page.events[0]?.eventType).toBe("order.created");
    expect(page.events[0]?.aggregateId).toBe("o1");
  });

  // THE property this task exists for: a settled row's absence of age_seconds
  // must survive parsing as absence, never as 0 and never derived from
  // created_at.
  it("keeps age_seconds absent on a row that never had one, rather than defaulting to 0", () => {
    const page = parseEstateOutbox(body);
    expect(page.events[1]?.ageSeconds).toBeUndefined();
    expect(page.events[0]?.ageSeconds).toBe(42);
  });

  // 0 is a real, valid age (a row created this instant) and must not collapse
  // into "absent" alongside it.
  it("distinguishes a genuine age of 0 from an absent one", () => {
    const page = parseEstateOutbox({
      ...body,
      events: [{ ...body.events[0], age_seconds: 0 }],
    });
    expect(page.events[0]?.ageSeconds).toBe(0);
  });

  // outbox_events.error has no CHECK constraint and the requeue path is a raw
  // UPDATE — a value this build has never seen must parse and be preserved,
  // never rejected and never coerced to a known code.
  it("accepts and preserves an unrecognised error string verbatim", () => {
    const page = parseEstateOutbox({
      ...body,
      events: [{ ...body.events[0], error: "some-future-failure-code-nobody-invented-yet" }],
    });
    expect(page.events[0]?.error).toBe("some-future-failure-code-nobody-invented-yet");
  });

  it("leaves error absent when the row never had one", () => {
    expect(parseEstateOutbox(body).events[0]?.error).toBeUndefined();
  });

  // A malformed body must throw rather than yield a half-built row — the same
  // rule `./audit.ts` and `./tenants.ts` state for their own parsers.
  it("throws PlatformApiError rather than coercing a malformed body", () => {
    expect(() => parseEstateOutbox(null)).toThrow(PlatformApiError);
    expect(() => parseEstateOutbox({ events: [], failures: [] })).toThrow(/not_implemented/);
    expect(() => parseEstateOutbox({ events: [], not_implemented: [] })).toThrow(/failures/);
    expect(() =>
      parseEstateOutbox({ failures: [], not_implemented: [] }),
    ).toThrow(/events/);
  });

  it("refuses an event with no source rather than rendering an unattributed row", () => {
    const { source: _dropped, ...noSource } = body.events[0] as Record<string, unknown>;
    expect(() => parseEstateOutbox({ ...body, events: [noSource] })).toThrow(/source/);
  });

  it("refuses an event missing a required field rather than defaulting it", () => {
    const { status: _dropped, ...noStatus } = body.events[0] as Record<string, unknown>;
    expect(() => parseEstateOutbox({ ...body, events: [noStatus] })).toThrow(/status/);
  });

  it("refuses a failure entry that is not an object", () => {
    expect(() => parseEstateOutbox({ ...body, failures: ["oops"] })).toThrow(/failures/);
  });

  // The 200-but-federated-nothing case: every configured product declared the
  // endpoint and answered 501 for this request. Distinct from a genuinely
  // empty outbox by the presence of names in not_implemented.
  it("parses a 200 whose events are empty because every product answered not-implemented", () => {
    const page = parseEstateOutbox({
      events: [],
      failures: [],
      not_implemented: ["mark8ly", "kora"],
    });
    expect(page.events).toHaveLength(0);
    expect(page.notImplemented).toEqual(["mark8ly", "kora"]);
  });

  it("parses a genuinely empty, fully-federated outbox distinctly (no not_implemented entries)", () => {
    const page = parseEstateOutbox({ events: [], failures: [], not_implemented: [] });
    expect(page.events).toHaveLength(0);
    expect(page.notImplemented).toHaveLength(0);
  });
});

describe("readOutbox", () => {
  afterEach(() => {
    vi.doUnmock("./platform-api");
    vi.resetModules();
  });

  // The whole reason this module exists: an unfederated estate must not
  // resolve to an empty page. It must reject, distinguishably, from a
  // genuinely empty read.
  it("surfaces the platform API's 501 as a rejection, not an empty EstateOutbox", async () => {
    vi.doMock("./platform-api", () => ({
      platformApiOrigin: () => "http://platform-api.test",
      platformRequestWithMeta: () =>
        Promise.reject(new PlatformApiError("outbox: NOT_IMPLEMENTED — no product federates it", 501)),
    }));
    const { readOutbox } = await import("./outbox");
    const caught: unknown = await readOutbox().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(501);
  });

  it("rejects with a 501 of its own when PLATFORM_API_ORIGIN is unset, rather than pretending to read a source that has no predecessor", async () => {
    vi.doMock("./platform-api", () => ({
      platformApiOrigin: () => null,
      platformRequestWithMeta: () => {
        throw new Error("must not be called when the origin is unset");
      },
    }));
    const { readOutbox } = await import("./outbox");
    // `vi.resetModules` gives this test its own copy of `./platform-api-error`
    // too, so the class `readOutbox` actually throws is compared against the
    // SAME identity rather than the one this file imported before the reset.
    const { PlatformApiError: FreshPlatformApiError } = await import("./platform-api-error");
    const caught: unknown = await readOutbox().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(FreshPlatformApiError);
    expect((caught as PlatformApiError).status).toBe(501);
  });

  it("resolves a well-formed page, with every row carrying its source", async () => {
    vi.doMock("./platform-api", () => ({
      platformApiOrigin: () => "http://platform-api.test",
      platformRequestWithMeta: () => Promise.resolve({ data: body, meta: undefined }),
    }));
    const { readOutbox } = await import("./outbox");
    const page = await readOutbox();
    expect(page.events).toHaveLength(2);
    expect(page.events.every((event) => typeof event.source === "string" && event.source !== "")).toBe(
      true,
    );
  });

  it("throws PlatformApiError rather than returning a half-built page when the body is malformed", async () => {
    vi.doMock("./platform-api", () => ({
      platformApiOrigin: () => "http://platform-api.test",
      platformRequestWithMeta: () => Promise.resolve({ data: { events: [] }, meta: undefined }),
    }));
    const { readOutbox } = await import("./outbox");
    // See the sibling test above for why this is a freshly-imported identity.
    const { PlatformApiError: FreshPlatformApiError } = await import("./platform-api-error");
    const caught: unknown = await readOutbox().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(FreshPlatformApiError);
  });
});
