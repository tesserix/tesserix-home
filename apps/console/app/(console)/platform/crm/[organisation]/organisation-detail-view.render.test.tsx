import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VOID_REASON_LENGTH } from "@/lib/crm-void-reason";
import type { ActivityRow, OpportunityRow } from "@/lib/db/crm-repo";

/**
 * The client half of the organisation detail tabs: what an operator is shown
 * and what a click does, with every server action stubbed. Each `describe`
 * below carries the reason its own suite exists.
 */

/**
 * The activity timeline is capped at `ACTIVITY_LIMIT` rows. Before #249 the
 * cap was silent: an operator who scrolled to the bottom of a long history
 * saw exactly what they would have seen at the actual bottom, and read the
 * record as complete. These tests are about the one sentence that tells them
 * otherwise — and about it staying absent when the history really does end.
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
  eraseContactAction: vi.fn(),
  scheduleNextAction: vi.fn(),
  voidOpportunityAction: vi.fn(),
  restoreOpportunityAction: vi.fn(),
  addActivity: vi.fn(),
  previewTemplate: vi.fn(),
  copyAndLogDm: vi.fn(),
}));

import { restoreOpportunityAction, voidOpportunityAction } from "./actions";
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
 * The opportunity void control (#251).
 *
 * A mis-clicked duplicate deal had no disposal at all before this; marking it
 * `lost` was the only way to get rid of it, and that pollutes every close-rate
 * number computed off the stage. These tests are about what makes the control
 * safe to ship: it is not reachable by a session that cannot use it, one
 * click on it voids nothing, and the confirmation says what a void actually
 * does — which is the whole argument for a void over the delete this replaced.
 */
describe("OpportunitiesTab void control", () => {
  const PRODUCTS = [{ context: "mark8ly", name: "Mark8ly" }] as const;

  beforeEach(() => {
    vi.mocked(voidOpportunityAction).mockReset();
    vi.mocked(voidOpportunityAction).mockResolvedValue({ ok: true });
    vi.mocked(restoreOpportunityAction).mockReset();
    vi.mocked(restoreOpportunityAction).mockResolvedValue({ ok: true });
    refresh.mockClear();
  });

  function opportunity(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
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
      voidedAt: null,
      voidedReason: null,
      ...overrides,
    };
  }

  function renderTab(canCrm: boolean, row: OpportunityRow = opportunity()) {
    render(
      <OpportunitiesTab
        organisationId={ORG_ID}
        opportunities={[row]}
        products={PRODUCTS}
        canCrm={canCrm}
      />,
    );
  }

  const voidControl = () => screen.getByRole("button", { name: /^void deal:/i });

  it("is absent for a session without crm", () => {
    renderTab(false);

    expect(screen.queryByRole("button", { name: /^void deal/i })).not.toBeInTheDocument();
  });

  it("is present, and names the deal it would void, for a session that holds it", () => {
    renderTab(true);

    // Named, not an icon: the accessible name has to say which deal, because
    // an organisation's cards differ only by their product.
    expect(voidControl()).toHaveAccessibleName(/mark8ly/i);
  });

  // The whole point of the control being a dialog rather than a stage option.
  it("voids nothing on the first click", () => {
    renderTab(true);

    fireEvent.click(voidControl());

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(voidOpportunityAction).not.toHaveBeenCalled();
  });

  // "Say what survives" — the discipline the reverted delete established, and
  // more literally true here, since a void destroys nothing at all.
  it("says what a void does and what survives it", () => {
    renderTab(true);
    fireEvent.click(voidControl());

    const description = screen.getByRole("dialog").textContent ?? "";
    expect(description).toMatch(/work queue/i);
    expect(description).toMatch(/close rate/i);
    expect(description).toMatch(/activity trail/i);
    expect(description).toMatch(/restore/i);
  });

  // The field refuses the 501st character rather than the round trip
  // refusing the whole reason after the operator has written it — the action
  // REJECTS an over-cap reason, it does not truncate.
  it("caps the reason field at the length the action will accept", () => {
    renderTab(true);
    fireEvent.click(voidControl());

    expect(screen.getByLabelText(/reason/i)).toHaveAttribute(
      "maxlength",
      String(MAX_VOID_REASON_LENGTH),
    );
  });

  it("voids the opportunity the control belongs to, with the reason given", async () => {
    const user = userEvent.setup();
    renderTab(true);
    await user.click(voidControl());
    await user.type(screen.getByLabelText(/reason/i), "Duplicate of the other deal");
    await user.click(screen.getByRole("button", { name: /^void deal$/i }));

    await waitFor(() =>
      expect(voidOpportunityAction).toHaveBeenCalledWith(
        OPPORTUNITY_ID,
        "Duplicate of the other deal",
      ),
    );
    // Unconditional: an already-voided deal is a reported no-op, so the card
    // the operator clicked from is exactly the one showing stale state.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // The column takes a reason or nothing, and whitespace is nothing.
  it("sends no reason when the operator gives none", async () => {
    renderTab(true);
    fireEvent.click(voidControl());
    fireEvent.click(screen.getByRole("button", { name: /^void deal$/i }));

    await waitFor(() =>
      expect(voidOpportunityAction).toHaveBeenCalledWith(OPPORTUNITY_ID, null),
    );
  });

  it("tells the operator when the void fails, and keeps the dialog open", async () => {
    vi.mocked(voidOpportunityAction).mockResolvedValue({
      ok: false,
      message: "This opportunity was migrated without a product.",
    });
    renderTab(true);
    fireEvent.click(voidControl());
    fireEvent.click(screen.getByRole("button", { name: /^void deal$/i }));

    expect(await screen.findByText(/migrated without a product/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  describe("a card whose deal is already voided", () => {
    const VOIDED = {
      voidedAt: "2026-09-01T10:00:00.000Z",
      voidedReason: "Duplicate of the other deal",
    } as const;

    it("says so in words, not by colour or an icon alone", () => {
      renderTab(true, opportunity(VOIDED));

      expect(screen.getByText("Voided")).toBeInTheDocument();
      expect(screen.getByText(/not counted towards close rates/i)).toBeInTheDocument();
      expect(screen.getByText(/duplicate of the other deal/i)).toBeInTheDocument();
    });

    // A second void with a different reason is a reported no-op that keeps
    // the FIRST reason, so offering the field again would imply an edit this
    // path cannot perform.
    it("offers a restore rather than a second void", () => {
      renderTab(true, opportunity(VOIDED));

      expect(screen.queryByRole("button", { name: /^void deal/i })).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^restore deal:/i }),
      ).toHaveAccessibleName(/mark8ly/i);
    });

    it("restores the deal the control belongs to", async () => {
      renderTab(true, opportunity(VOIDED));

      fireEvent.click(screen.getByRole("button", { name: /^restore deal:/i }));

      await waitFor(() =>
        expect(restoreOpportunityAction).toHaveBeenCalledWith(OPPORTUNITY_ID),
      );
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("tells the operator when the restore fails", async () => {
      vi.mocked(restoreOpportunityAction).mockResolvedValue({
        ok: false,
        message: "This opportunity was migrated without a product.",
      });
      renderTab(true, opportunity(VOIDED));

      fireEvent.click(screen.getByRole("button", { name: /^restore deal:/i }));

      expect(await screen.findByText(/migrated without a product/i)).toBeInTheDocument();
    });

    it("hides both controls from a session without crm", () => {
      renderTab(false, opportunity(VOIDED));

      // The badge is a fact about the record, not a control — it stays.
      expect(screen.getByText("Voided")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^restore deal/i })).not.toBeInTheDocument();
    });
  });
});
