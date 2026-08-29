import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const readOutbox = vi.fn();

vi.mock("@/lib/outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outbox")>()),
  readOutbox: (...args: unknown[]) => readOutbox(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import type { EstateOutbox } from "@/lib/outbox";
import EstateOutboxPage, {
  OUTBOX_EMPTY_MESSAGE,
  OUTBOX_UNAVAILABLE_TITLE,
  emptyMessageFor,
  outboxReadError,
  outboxState,
} from "./page";
import { OutboxTable, errorLabel, formatAge } from "./outbox-table";

// The page is a server component, exercised the same way `inbox/page.test.tsx`
// exercises its sibling: its default export is awaited and rendered directly,
// and its logic is exercised through the exported pure functions. The client
// table is rendered directly, matching the split every federated surface uses.

const event = {
  id: "mark8ly:e1",
  tenantId: "t1",
  aggregate: "order",
  aggregateId: "o1",
  eventType: "order.created",
  status: "pending",
  createdAt: "2026-08-27T09:00:00Z",
  ageSeconds: 42,
  source: "mark8ly",
};

const outbox = (over: Partial<EstateOutbox> = {}): EstateOutbox => ({
  events: [event],
  failures: [],
  notImplemented: [],
  ...over,
});

describe("the three response states this surface must render differently", () => {
  // State 1: 501, no `events` key at all — nothing is federated. Production's
  // state today.
  it("renders a 501 as 'not federated', never as an empty table", () => {
    const state = outboxState({ error: new PlatformApiError("outbox: not set", 501), rows: [] });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("renders this surface's own 501 copy through the table, not the kit's observability default", () => {
    // Asserted through a render rather than a constant checked against
    // itself: `OUTBOX_UNAVAILABLE_MESSAGE` matching its own text would pass
    // regardless of whether `outboxReadError`/`resolveState` ever wire it up.
    const state = outboxState({ error: new PlatformApiError("outbox: not set", 501), rows: [] });
    render(
      <OutboxTable
        outbox={outbox({ events: [] })}
        state={state}
        emptyMessage={OUTBOX_EMPTY_MESSAGE}
        reauthReturnTo="/platform/outbox"
      />,
    );
    expect(screen.getByText(OUTBOX_UNAVAILABLE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/nothing to retry/)).toBeInTheDocument();
  });

  // State 2: 200 with `events: []`, nothing else missing — a genuinely
  // healthy, fully-federated outbox.
  it("renders a genuinely empty outbox as empty, not as an error", () => {
    const state = outboxState({ error: null, rows: [] });
    expect(state.kind).toBe("empty");
    expect(emptyMessageFor({ failures: [], notImplemented: [] })).toBe(OUTBOX_EMPTY_MESSAGE);
  });

  // State 3: 200 with `events: []` AND `notImplemented` populated — every
  // configured product said 501 for this request. Same SurfaceState kind as
  // state 2 (there is genuinely nothing to tabulate), but the copy — and the
  // banner rendered above it — must not claim the estate's outbox is clean.
  it("does not claim a clean outbox when every product answered not-implemented", () => {
    const state = outboxState({ error: null, rows: [] });
    expect(state.kind).toBe("empty");
    const message = emptyMessageFor({ failures: [], notImplemented: ["mark8ly", "kora"] });
    expect(message).not.toBe(OUTBOX_EMPTY_MESSAGE);
    expect(message).toMatch(/not evidence/);
    expect(message).toMatch(/2 products/);
  });

  it("leaves a real failure alone rather than dressing it up as a 501", () => {
    const surfaced = outboxReadError(new PlatformApiError("boom", 502));
    expect(surfaced?.unavailable).toBeUndefined();
  });
});

describe("outboxState", () => {
  it("renders rows even when a source failed or answered not-implemented", () => {
    expect(outboxState({ error: null, rows: [event] }).kind).toBe("ready");
  });

  it("replaces the table only when the whole read threw", () => {
    expect(outboxState({ error: new PlatformApiError("boom", 502), rows: [] }).kind).toBe("error");
  });
});

describe("formatAge", () => {
  // The other property this task exists for: absence renders as absence.
  it("renders an absent age as an em dash, never 0s", () => {
    expect(formatAge(undefined)).toBe("—");
  });

  it("renders a genuine 0 as 0s, not as absent", () => {
    expect(formatAge(0)).toBe("0s");
  });

  it("renders seconds, minutes, hours and days", () => {
    expect(formatAge(42)).toBe("42s");
    expect(formatAge(90)).toBe("1m");
    expect(formatAge(7200)).toBe("2h");
    expect(formatAge(172800)).toBe("2d");
  });
});

describe("errorLabel", () => {
  it("renders an absent error as an em dash", () => {
    expect(errorLabel(undefined)).toBe("—");
  });

  // Never a switch — any string may appear, and an unrecognised one is shown
  // verbatim rather than swallowed or mapped to "Unknown".
  it("renders an unrecognised error string verbatim", () => {
    expect(errorLabel("some-future-code-nobody-invented-yet")).toBe(
      "some-future-code-nobody-invented-yet",
    );
  });
});

describe("OutboxTable", () => {
  it("renders an event with its source, status and age", () => {
    render(
      <OutboxTable
        outbox={outbox()}
        state={outboxState({ error: null, rows: [event] })}
        emptyMessage={OUTBOX_EMPTY_MESSAGE}
        reauthReturnTo="/platform/outbox"
      />,
    );
    expect(screen.getByText("mark8ly")).toBeInTheDocument();
    expect(screen.getByText("order.created")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("42s")).toBeInTheDocument();
  });

  it("warns that the outbox is incomplete when a source failed", () => {
    render(
      <OutboxTable
        outbox={outbox({ failures: [{ source: "kora", message: "connection failed" }] })}
        state={outboxState({ error: null, rows: [event] })}
        emptyMessage={OUTBOX_EMPTY_MESSAGE}
        reauthReturnTo="/platform/outbox"
      />,
    );
    expect(screen.getByText(/outbox is incomplete/i)).toBeInTheDocument();
  });

  // The banner that makes state 3 legible: distinct from the failures
  // callout, and present even when the table itself renders rows from other
  // products.
  it("names the products that reported no events for this request, separately from failures", () => {
    render(
      <OutboxTable
        outbox={outbox({ notImplemented: ["homechef"] })}
        state={outboxState({ error: null, rows: [event] })}
        emptyMessage={OUTBOX_EMPTY_MESSAGE}
        reauthReturnTo="/platform/outbox"
      />,
    );
    expect(screen.getByText(/reported no outbox events/i)).toBeInTheDocument();
    expect(screen.getByText(/homechef/)).toBeInTheDocument();
    expect(screen.queryByText(/outbox is incomplete/i)).toBeNull();
  });

  it("renders the plain empty state with no notices when nothing is missing", () => {
    render(
      <OutboxTable
        outbox={outbox({ events: [] })}
        state={outboxState({ error: null, rows: [] })}
        emptyMessage={OUTBOX_EMPTY_MESSAGE}
        reauthReturnTo="/platform/outbox"
      />,
    );
    expect(screen.getByText(OUTBOX_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/reported no outbox events/i)).toBeNull();
    expect(screen.queryByText(/outbox is incomplete/i)).toBeNull();
  });
});

describe("EstateOutboxPage", () => {
  it("renders the ledger when the read succeeds", async () => {
    readOutbox.mockResolvedValue(outbox());
    render(await EstateOutboxPage());
    expect(screen.getByText("mark8ly")).toBeInTheDocument();
  });

  it("renders the 501 callout rather than the route error boundary when nothing is federated", async () => {
    readOutbox.mockRejectedValue(new PlatformApiError("outbox: not set", 501));
    render(await EstateOutboxPage());
    expect(screen.getByText(OUTBOX_UNAVAILABLE_TITLE)).toBeInTheDocument();
  });

  it("renders a legible error for a real failure, not an empty ledger", async () => {
    readOutbox.mockRejectedValue(new PlatformApiError("boom", 502));
    render(await EstateOutboxPage());
    // Not just "the empty message is absent" — that would also pass if the
    // page rendered nothing at all. The error surface itself must be present.
    expect(screen.queryByText(OUTBOX_EMPTY_MESSAGE)).toBeNull();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  // Response state 3, end-to-end: federated, but every configured product
  // answered not-implemented for this request. Zero events, same as a
  // genuinely clean outbox, so this is the shape most likely to be mistaken
  // for it in production — an operator's first encounter with this surface
  // is plausibly this one, not the plain-empty case.
  it("renders response state 3 end-to-end: federated, every configured product answered not-implemented", async () => {
    readOutbox.mockResolvedValue(outbox({ events: [], notImplemented: ["mark8ly", "kora"] }));
    render(await EstateOutboxPage());
    expect(screen.queryByText(OUTBOX_EMPTY_MESSAGE)).toBeNull();
    expect(screen.getByText(/reported no outbox events/i)).toBeInTheDocument();
    expect(screen.getByText(/mark8ly, kora/)).toBeInTheDocument();
  });
});
