import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlatformApiError } from "@/lib/platform-api";
import { DetailLayout } from "@/components/kit/detail-layout";
import { detailState } from "./page";
import type { TicketDetail } from "@/lib/tickets";

// The page reaches for the session and the cookie jar at module scope's edge;
// neither exists in a test process.
vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => "tx_session=abc" }),
}));
vi.mock("@tesserix/platform-auth", () => ({
  getCurrentSession: async () => ({ sub: "op-1", roles: ["respond"] }),
  hasCapability: () => true,
}));

// The same defect the queue had, at `page.tsx:49`: `triageState(error, null)`
// can only return instrumentation-unavailable | error | ready, so a null
// detail with no error resolved to `ready` and DetailLayout rendered a title,
// an empty summary rail and no tabs — with nothing saying the record never
// arrived. Task 2 flagged it and left it; this is the fix.

const DETAIL = {
  ticket: { id: "5f0b", subject: "Payout missing" },
  replies: [],
} as unknown as TicketDetail;

describe("detailState", () => {
  it("reports empty — not ready — when the detail never arrived", () => {
    expect(detailState({ error: null, detail: null })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is a record", () => {
    expect(detailState({ error: null, detail: DETAIL })).toEqual({ kind: "ready" });
  });

  it("maps a 501 to instrumentation-unavailable, not to error", () => {
    expect(
      detailState({ error: new PlatformApiError("parked", 501), detail: null }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });

  it("maps a real failure to error, not to instrumentation-unavailable", () => {
    // Guards the guard above: a blanket mapping would satisfy it too.
    expect(detailState({ error: new PlatformApiError("boom", 500), detail: null })).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("prefers the error over the missing record", () => {
    // A failed fetch also has no detail; "this record has no details" would
    // tell an operator the ticket is blank when it is simply unread.
    expect(
      detailState({ error: new PlatformApiError("boom", 500), detail: null }).kind,
    ).toBe("error");
  });
});

describe("the detail surface actually says something went wrong", () => {
  it("renders a state instead of an empty layout when there is no record", () => {
    render(
      <DetailLayout
        title="Ticket"
        summary={[]}
        tabs={[]}
        state={detailState({ error: null, detail: null })}
      />,
    );

    expect(screen.getByText("This record has no details to show.")).toBeInTheDocument();
    // What shipped: a summary rail and a tablist with nothing in them.
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
