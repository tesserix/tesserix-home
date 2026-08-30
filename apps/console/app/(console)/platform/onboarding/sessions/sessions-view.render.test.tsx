import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/onboarding/sessions",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import type { OnboardingSession } from "@/lib/onboarding-sessions";
import { formatIdle, formatInstant, outcomeLabel, SessionsView } from "./sessions-view";

const ROW: OnboardingSession = {
  id: "sess-1",
  email: "merchant@example.com",
  status: "in_progress",
  createdAt: "2026-08-28T09:00:00Z",
  lastActivityAt: "2026-08-29T11:30:00Z",
  idleHours: 21.5,
  abandoned: false,
  completedAt: null,
  tenantId: null,
};

function renderView(props: Partial<Parameters<typeof SessionsView>[0]> = {}) {
  render(
    <SessionsView
      descriptors={[{ key: "status", label: "Status", type: "search" }]}
      values={{}}
      source="mark8ly"
      rows={[ROW]}
      total={1}
      pager={{ precedingCount: 0, nextHref: null, previousHref: null }}
      state={{ kind: "ready" }}
      emptyMessage="No onboarding sessions match this view."
      scopeNote="Times are RFC 3339 instants."
      reauthReturnTo="/platform/onboarding/sessions"
      {...props}
    />,
  );
}

describe("formatInstant", () => {
  it("renders an unparseable value verbatim rather than inventing a placeholder", () => {
    // The product sent something, and showing what it sent is how somebody
    // finds out what is wrong with it.
    expect(formatInstant("not-a-date")).toBe("not-a-date");
  });

  it("renders an absent completion as a dash, not as an epoch", () => {
    expect(formatInstant(null)).toBe("—");
  });

  it("renders a real instant to the minute", () => {
    expect(formatInstant("2026-08-29T11:30:45Z")).toBe("2026-08-29 11:30");
  });
});

describe("formatIdle", () => {
  it("reports the product's own measurement at a readable scale", () => {
    expect(formatIdle(0.5)).toBe("30m");
    expect(formatIdle(21.5)).toBe("22h");
    expect(formatIdle(96)).toBe("4d");
  });
});

describe("outcomeLabel", () => {
  it("calls a completed session completed even when it was once abandoned", () => {
    // Reporting a converted merchant as abandoned would put them on a chase
    // list; the order of these checks is the whole of that guarantee.
    expect(
      outcomeLabel({ ...ROW, abandoned: true, completedAt: "2026-08-29T12:00:00Z" }),
    ).toBe("Completed");
  });

  it("uses the product's own abandoned flag rather than deriving one from idle time", () => {
    expect(outcomeLabel({ ...ROW, abandoned: true, idleHours: 0 })).toBe("Abandoned");
    expect(outcomeLabel({ ...ROW, abandoned: false, idleHours: 999 })).toBe("In flight");
  });
});

describe("SessionsView", () => {
  it("renders the merchant and the product's status untranslated", () => {
    renderView();
    expect(screen.getByText("merchant@example.com")).toBeTruthy();
    expect(screen.getByText("in_progress")).toBeTruthy();
  });

  it("names the tenant a converted session became", () => {
    renderView({ rows: [{ ...ROW, completedAt: "2026-08-29T12:00:00Z", tenantId: "tnt-9" }] });
    expect(screen.getByText(/tnt-9/)).toBeTruthy();
  });

  it("renders no tenant line at all for a session that has not converted", () => {
    // A placeholder would make "still a session" look like "the product sent
    // nothing".
    renderView();
    expect(screen.queryByText(/tenant/i)).toBeNull();
  });

  it("shows no rows outside the ready state", () => {
    renderView({ state: { kind: "error", message: "mark8ly: upstream down" }, rows: [] });
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    expect(screen.getByText(/upstream down/)).toBeTruthy();
  });

  it("keeps the filter bar in every state, because changing a filter is the way out", () => {
    renderView({ state: { kind: "filtered-empty" }, rows: [] });
    expect(screen.getByRole("search")).toBeTruthy();
  });
});
