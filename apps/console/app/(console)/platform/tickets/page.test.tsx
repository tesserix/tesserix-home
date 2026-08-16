import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlatformApiError } from "@/lib/platform-api";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import { QUEUE_EMPTY_MESSAGE, queueState } from "./page";

// The queue previously resolved its state with `triageState(error, null)`,
// which returns only instrumentation-unavailable | error | ready. Zero rows
// therefore reported `ready`, the list rendered an empty <ul>, and the
// emptyMessage was dead code. These tests assert the states are reachable
// rather than eyeballing them.

const ROW: QueueItem = {
  key: "mark8ly#412",
  title: "Cannot log in after password reset",
  product: "mark8ly",
  waitingSince: "2026-08-16T09:00:00.000Z",
  severity: "normal",
  href: "/platform/tickets/2f6c",
};

describe("queueState", () => {
  it("reports empty — not ready — when nothing is waiting and nothing is filtered", () => {
    expect(queueState({ error: null, rows: [], filtered: false })).toEqual({ kind: "empty" });
  });

  it("reports filtered-empty when a filter is active and nothing matches", () => {
    expect(queueState({ error: null, rows: [], filtered: true })).toEqual({
      kind: "filtered-empty",
    });
  });

  it("reports ready once there is a row", () => {
    expect(queueState({ error: null, rows: [ROW], filtered: false })).toEqual({ kind: "ready" });
  });

  it("maps a 501 to instrumentation-unavailable, not to error", () => {
    // A parked data plane must never read as a failure an operator can retry.
    expect(
      queueState({ error: new PlatformApiError("parked", 501), rows: [], filtered: false }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });

  it("maps a real failure to error, not to instrumentation-unavailable", () => {
    // Guards the guard above: a blanket mapping would pass that test too.
    expect(
      queueState({ error: new PlatformApiError("boom", 500), rows: [], filtered: false }),
    ).toEqual({ kind: "error", message: "boom" });
  });

  it("prefers the error over the empty row count", () => {
    // A failed fetch also has zero rows; reporting "nothing waiting" there
    // would tell an operator the queue is clear when it is simply unread.
    expect(
      queueState({ error: new PlatformApiError("boom", 500), rows: [], filtered: false }).kind,
    ).toBe("error");
  });
});

describe("the queue's empty states actually render", () => {
  function renderQueue(state: ReturnType<typeof queueState>, onClearFilters?: () => void) {
    render(
      <QueueList
        items={[]}
        state={state}
        emptyMessage={QUEUE_EMPTY_MESSAGE}
        onClearFilters={onClearFilters}
      />,
    );
  }

  it("reaches the emptyMessage that used to be unreachable", () => {
    renderQueue(queueState({ error: null, rows: [], filtered: false }));

    expect(screen.getByText(QUEUE_EMPTY_MESSAGE)).toBeInTheDocument();
    // Not an empty <ul>, which is what shipped.
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("offers a way out of a filtered no-match instead of the empty copy", () => {
    const onClearFilters = vi.fn();
    renderQueue(queueState({ error: null, rows: [], filtered: true }), onClearFilters);

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_EMPTY_MESSAGE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("renders a 501 as a parked notice rather than as empty or as a failure", () => {
    renderQueue(queueState({ error: new PlatformApiError("parked", 501), rows: [], filtered: false }));

    expect(screen.getByRole("status")).toHaveTextContent("Instrumentation unavailable");
    expect(screen.queryByText(QUEUE_EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
