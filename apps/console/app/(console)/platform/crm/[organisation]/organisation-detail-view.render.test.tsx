import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow, OpportunityRow } from "@/lib/db/crm-repo";

/**
 * The client half of the organisation detail tabs: what an operator is shown
 * and what a click does, with every server action stubbed. Each `describe`
 * below carries the reason its own suite exists.
 */

// `refresh` is shared rather than per-render so a test can assert the view
// asked for one. `vi.hoisted` because `vi.mock`'s factory is hoisted above
// this file's other statements and would otherwise read it before it exists.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
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
  deleteOpportunityAction: vi.fn(),
  eraseContactAction: vi.fn(),
  scheduleNextAction: vi.fn(),
  addActivity: vi.fn(),
  previewTemplate: vi.fn(),
  copyAndLogDm: vi.fn(),
}));

import { deleteOpportunityAction } from "./actions";
import { ActivityTab, OpportunitiesTab } from "./organisation-detail-view";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OPPORTUNITY_ID = "22222222-2222-4222-8222-222222222222";

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

/**
 * The opportunity delete control (#251).
 *
 * A mis-clicked duplicate deal had no disposal at all before this; marking it
 * `lost` was the only way to get rid of it, and that pollutes every close-rate
 * number computed off the stage. These tests are about the two things that
 * make the control safe to ship: it is not reachable by a session that cannot
 * use it, and one click on it deletes nothing.
 */
describe("OpportunitiesTab delete control", () => {
  const PRODUCTS = [{ context: "mark8ly", name: "Mark8ly" }] as const;

  beforeEach(() => {
    vi.mocked(deleteOpportunityAction).mockReset();
    vi.mocked(deleteOpportunityAction).mockResolvedValue({ ok: true });
    refresh.mockClear();
  });

  function opportunity(): OpportunityRow {
    return {
      id: OPPORTUNITY_ID,
      product: "mark8ly",
      stage: "qualified",
      owner: null,
      nextActionAt: null,
      nextActionNote: null,
      lastContactedAt: null,
      isStarred: false,
      closedAt: null,
      lostReason: null,
      createdAt: "2026-08-01T09:00:00.000Z",
    };
  }

  function renderTab(canHardDelete: boolean) {
    render(
      <OpportunitiesTab
        organisationId={ORG_ID}
        opportunities={[opportunity()]}
        products={PRODUCTS}
        canHardDelete={canHardDelete}
      />,
    );
  }

  const deleteControl = () => screen.getByRole("button", { name: /^delete deal/i });

  it("is absent for a session without hard-delete", () => {
    renderTab(false);

    expect(screen.queryByRole("button", { name: /^delete deal/i })).not.toBeInTheDocument();
  });

  it("is present, and names the deal it would delete, for a session that holds it", () => {
    renderTab(true);

    // Named, not an icon: the accessible name has to say which deal, because
    // an organisation's cards differ only by their product.
    expect(deleteControl()).toHaveAccessibleName(/mark8ly/i);
  });

  // The whole point of the control being a dialog rather than a stage option.
  it("deletes nothing on the first click", () => {
    renderTab(true);

    fireEvent.click(deleteControl());

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(deleteOpportunityAction).not.toHaveBeenCalled();
  });

  it("says what survives the delete", () => {
    renderTab(true);
    fireEvent.click(deleteControl());

    const description = screen.getByRole("dialog").textContent ?? "";
    expect(description).toMatch(/organisation/i);
    expect(description).toMatch(/contacts/i);
    expect(description).toMatch(/other deals/i);
    expect(description).toMatch(/timeline/i);
  });

  it("deletes the opportunity the control belongs to, once confirmed", async () => {
    renderTab(true);
    fireEvent.click(deleteControl());
    fireEvent.click(screen.getByRole("button", { name: /^delete deal$/i }));

    await waitFor(() => expect(deleteOpportunityAction).toHaveBeenCalledWith(OPPORTUNITY_ID));
    // Unconditional: the action revalidates nothing when the deal was already
    // gone, so without this the card would survive its own delete.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("tells the operator when the delete fails, and keeps the dialog open", async () => {
    vi.mocked(deleteOpportunityAction).mockResolvedValue({
      ok: false,
      message: "You do not have permission to delete this.",
    });
    renderTab(true);
    fireEvent.click(deleteControl());
    fireEvent.click(screen.getByRole("button", { name: /^delete deal$/i }));

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
