import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "@/lib/db/crm-repo";

/**
 * The activity timeline is capped at `ACTIVITY_LIMIT` rows. Before #249 the
 * cap was silent: an operator who scrolled to the bottom of a long history
 * saw exactly what they would have seen at the actual bottom, and read the
 * record as complete. These tests are about the one sentence that tells them
 * otherwise — and about it staying absent when the history really does end.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Every action reachable from this tab, stubbed: `./actions` is a "use
// server" module and nothing here submits anything.
vi.mock("./actions", () => ({
  addContactAction: vi.fn(),
  updateContactAction: vi.fn(),
  setPrimaryContactAction: vi.fn(),
  changeStage: vi.fn(),
  createOpportunityAction: vi.fn(),
  deleteOrganisationAction: vi.fn(),
  eraseContactAction: vi.fn(),
  scheduleNextAction: vi.fn(),
  addActivity: vi.fn(),
  previewTemplate: vi.fn(),
  copyAndLogDm: vi.fn(),
}));

import { ActivityTab } from "./organisation-detail-view";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function activity(id: string): ActivityRow {
  return {
    id,
    opportunityId: null,
    kind: "note",
    actor: "ava",
    body: `note ${id}`,
    occurredAt: "2026-08-01T09:00:00.000Z",
  };
}

function renderActivityTab(
  activities: readonly ActivityRow[],
  hasMoreActivities: boolean,
) {
  render(
    <ActivityTab
      organisationId={ORG_ID}
      activities={activities}
      hasMoreActivities={hasMoreActivities}
      opportunities={[]}
      contacts={[]}
      templates={[]}
    />,
  );
}

describe("ActivityTab", () => {
  it("renders the timeline it was given", () => {
    renderActivityTab([activity("a1"), activity("a2")], false);

    expect(screen.getByText("note a1")).toBeInTheDocument();
    expect(screen.getByText("note a2")).toBeInTheDocument();
  });

  it("says so when the timeline is truncated", () => {
    renderActivityTab([activity("a1")], true);

    expect(screen.getByText(/older activity is not shown/i)).toBeInTheDocument();
  });

  it("says nothing when the whole history fits", () => {
    renderActivityTab([activity("a1")], false);

    expect(screen.queryByText(/older activity is not shown/i)).not.toBeInTheDocument();
  });

  // An empty timeline is not a truncated one — the "no activity recorded yet"
  // line and the truncation notice would contradict each other on screen, and
  // only the empty state can be true.
  it("says nothing about older activity when there is none at all", () => {
    renderActivityTab([], false);

    expect(screen.getByText("No activity recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText(/older activity is not shown/i)).not.toBeInTheDocument();
  });
});
