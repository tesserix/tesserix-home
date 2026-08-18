import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SuppressedContactError } from "@/lib/db/crm-repo";
import type { OpportunityRow } from "@/lib/db/crm-repo";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  addActivity: vi.fn(),
  scheduleNextAction: vi.fn(),
}));

import { addActivity, scheduleNextAction } from "./actions";
import { ActivityComposer } from "./activity-composer";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function opportunity(overrides: Partial<OpportunityRow> & { id: string }): OpportunityRow {
  return {
    product: null,
    stage: "new",
    owner: null,
    nextActionAt: null,
    nextActionNote: null,
    lastContactedAt: null,
    isStarred: false,
    closedAt: null,
    lostReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const OPEN_DEAL = opportunity({ id: "aaaa1111-0000-0000-0000-000000000000" });
const SECOND_OPEN_DEAL = opportunity({
  id: "bbbb2222-0000-0000-0000-000000000000",
  stage: "qualified",
  product: "mark8ly",
});
const WON_DEAL = opportunity({
  id: "cccc3333-0000-0000-0000-000000000000",
  stage: "won",
  product: "mark8ly",
});

// Radix's Select relies on browser APIs jsdom does not implement. Without
// these the trigger throws before the listbox ever opens, which would look
// like a component failure rather than a missing environment.
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

// Radix marks the rest of the document inert while the listbox is open by
// setting `pointer-events: none` on `document.body`; userEvent refuses to
// click through that by default.
function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

function renderComposer(opportunities: readonly OpportunityRow[] = [OPEN_DEAL]) {
  render(<ActivityComposer organisationId={ORG_ID} opportunities={opportunities} />);
}

/** Opens the kind Select and picks the option with the given label. */
async function chooseKind(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: /activity/i }));
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  await user.click(screen.getByRole("option", { name: label }));
}

async function log(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /log activity/i }));
}

/** The composer survived whatever just happened. React unmounts the whole
 *  root when a child throws while rendering, so a still-present submit
 *  button is what tells "the prompt was correctly withheld" apart from "the
 *  prompt exploded and took the form with it". */
function expectComposerStillUsable() {
  expect(screen.getByRole("button", { name: /log activity/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/what happened/i)).toBeInTheDocument();
}

describe("ActivityComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addActivity).mockResolvedValue({ ok: true });
    vi.mocked(scheduleNextAction).mockResolvedValue({ ok: true });
  });

  // #245: five of the six kinds were unreachable, so the CRM could not record
  // that anyone had actually been contacted.
  it("offers every kind an operator may author, and starts on Note", async () => {
    const user = setupUser();
    renderComposer();

    await user.click(screen.getByRole("combobox", { name: /activity/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    for (const label of ["Note", "Call", "DM sent", "DM received", "Email sent", "Email received"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("option", { name: "Note" })).toHaveAttribute("aria-selected", "true");
  });

  it("logs the chosen kind against the organisation, naming no deal", async () => {
    const user = setupUser();
    renderComposer();

    await chooseKind(user, "Call");
    await user.type(screen.getByLabelText(/what happened/i), "spoke to Ana");
    await log(user);

    await waitFor(() =>
      expect(addActivity).toHaveBeenCalledWith({
        organisationId: ORG_ID,
        kind: "call",
        body: "spoke to Ana",
      }),
    );
  });

  it("requires words for a note but not for a call — the call itself is the record", async () => {
    const user = setupUser();
    renderComposer();

    expect(screen.getByRole("button", { name: /log activity/i })).toBeDisabled();
    await chooseKind(user, "Call");
    expect(screen.getByRole("button", { name: /log activity/i })).toBeEnabled();
  });

  // The control that has never run in production. Once an outbound kind is
  // reachable it can refuse, and the refusal has to reach the operator with
  // its own words — the message the repo raises, not a generic failure.
  it("shows the do-not-contact refusal verbatim", async () => {
    const user = setupUser();
    const refusal = new SuppressedContactError(ORG_ID);
    vi.mocked(addActivity).mockResolvedValue({ ok: false, message: refusal.message });
    renderComposer();

    await chooseKind(user, "Email sent");
    await log(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(refusal.message);
    expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
  });

  describe("the follow-up prompt", () => {
    it("offers a follow-up after contact, prefilled, and schedules it against the deal", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "Call");
      await log(user);

      const prompt = await screen.findByRole("group", { name: /follow-up/i });
      const when = screen.getByLabelText(/when/i) as HTMLInputElement;
      expect(when.value).not.toBe("");

      await user.click(within(prompt).getByRole("button", { name: /^schedule$/i }));

      await waitFor(() =>
        expect(scheduleNextAction).toHaveBeenCalledWith(
          expect.objectContaining({
            organisationId: ORG_ID,
            opportunityId: OPEN_DEAL.id,
            at: expect.any(String),
          }),
        ),
      );
    });

    it("lets the operator decline — it prompts, it does not force", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "Call");
      await log(user);
      await screen.findByRole("group", { name: /follow-up/i });

      await user.click(screen.getByRole("button", { name: /not now/i }));

      await waitFor(() => expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull());
      expect(scheduleNextAction).not.toHaveBeenCalled();
    });

    it("asks which deal only when there is more than one open", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL, SECOND_OPEN_DEAL]);

      await chooseKind(user, "Call");
      await log(user);
      await screen.findByRole("group", { name: /follow-up/i });

      expect(screen.getByRole("combobox", { name: /deal/i })).toBeInTheDocument();
    });

    it("does not prompt after a note — nothing was contacted", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await user.type(screen.getByLabelText(/what happened/i), "a thought");
      await log(user);

      await waitFor(() => expect(addActivity).toHaveBeenCalled());
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
    });

    // Both halves. "The prompt is absent" is also true of a prompt that threw
    // while rendering — an earlier version of this test passed against a
    // composer that crashed on `targets[0]` with no target to read — so this
    // asserts the composer is still standing and still usable afterwards.
    it("does not prompt when there is no open deal to schedule against", async () => {
      const user = setupUser();
      renderComposer([WON_DEAL]);

      await chooseKind(user, "Call");
      await log(user);

      await waitFor(() => expect(addActivity).toHaveBeenCalled());
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
      expectComposerStillUsable();
    });

    // `setNextAction` refuses a grandfathered deal (migration 0021) with
    // MissingProductError, so offering one here would be offering a control
    // that cannot succeed.
    it("does not offer a deal the scheduler would refuse", async () => {
      const user = setupUser();
      const grandfathered = opportunity({
        id: "dddd4444-0000-0000-0000-000000000000",
        stage: "qualified",
        product: null,
      });
      renderComposer([grandfathered]);

      await chooseKind(user, "Call");
      await log(user);

      await waitFor(() => expect(addActivity).toHaveBeenCalled());
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
      expectComposerStillUsable();
    });
  });
});
