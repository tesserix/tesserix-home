import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SuppressedContactError } from "@/lib/db/crm-repo";
import { NEXT_ACTION_DAYS } from "@/lib/crm";
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
    voidedAt: null,
    voidedReason: null,
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

/**
 * The calendar day a `datetime-local` value falls on, `YYYY-MM-DD`.
 *
 * CALENDAR DAYS, NOT ELAPSED HOURS, and that is not a convenience. The prompt
 * lands the default on 09:00 local, so the gap between "now" and the prefilled
 * value is anywhere from 3.4 to 4.4 days depending on the time of day the test
 * runs — an elapsed-hours assertion passes in the morning and fails after
 * lunch. What the product actually promises is a day, so that is what is
 * asserted.
 */
function dayOf(value: string): string {
  return value.slice(0, 10);
}

/** `YYYY-MM-DD` of local midnight `days` from now — built the same way the
 *  composer builds it, so it crosses months and DST identically. */
function dayFromNow(days: number): string {
  const at = new Date();
  at.setDate(at.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
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
 *  prompt exploded and took the form with it".
 *
 *  ASYNC, and that is load-bearing (#283). The submit button reads "Saving…"
 *  while `pending` is true and only returns to "Log activity" once the action
 *  settles. `getByRole` does not retry, so under a loaded CI runner this
 *  asserted against a composer that was still mid-submit and failed with
 *  "Unable to find ... /log activity/i" — a timing artefact reported as a
 *  product failure. `findByRole` waits for the settled state, which is also
 *  the only state in which "still usable" means anything. */
async function expectComposerStillUsable() {
  expect(await screen.findByRole("button", { name: /log activity/i })).toBeInTheDocument();
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

    // Dismissal now KEEPS the date the log wrote instead of leaving the lead
    // unscheduled, which is why the control says "Leave it" rather than "Not
    // now": there is no offer being declined any more.
    it("lets the operator walk away, keeping the follow-up the log scheduled", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "Call");
      await log(user);
      await screen.findByRole("group", { name: /follow-up/i });

      await user.click(screen.getByRole("button", { name: /leave it/i }));

      await waitFor(() => expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull());
      expect(scheduleNextAction).not.toHaveBeenCalled();
    });

    /**
     * "A default, not a rule" (#502): the operator must be able to CLEAR the
     * date in the same interaction, not only move it. Some leads deserve
     * never, and `next_action_at = NULL` is the only way to say so.
     *
     * The button was disabled on an empty field until now, which was harmless
     * while nothing else wrote the column and is not harmless once the log
     * writes a default — a default you cannot remove is a rule.
     */
    it("lets the operator clear the follow-up entirely", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "DM sent");
      await log(user);
      const prompt = await screen.findByRole("group", { name: /follow-up/i });

      await user.clear(screen.getByLabelText(/when/i));

      const clear = within(prompt).getByRole("button", { name: /clear follow-up/i });
      expect(clear).toBeEnabled();
      await user.click(clear);

      await waitFor(() =>
        expect(scheduleNextAction).toHaveBeenCalledWith(
          expect.objectContaining({ opportunityId: OPEN_DEAL.id, at: null }),
        ),
      );
    });

    /**
     * The prompt prefills the date the WRITE PATH just wrote, not a different
     * one of its own. It used to suggest three days while `crm-outreach.ts`
     * scheduled four, so accepting the offer silently moved the date and no
     * reader could say which number was the product's answer.
     *
     * Asserted as a day offset from `NEXT_ACTION_DAYS` rather than a literal,
     * so changing the constant moves both ends or neither.
     */
    it("prefills the date the log just scheduled, for an outbound kind", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "DM sent");
      await log(user);
      await screen.findByRole("group", { name: /follow-up/i });

      const when = screen.getByLabelText(/when/i) as HTMLInputElement;
      expect(dayOf(when.value)).toBe(dayFromNow(NEXT_ACTION_DAYS));
    });

    // A reply is due NOW — the write path sets `next_action_at = now()`, so a
    // prompt suggesting four days out would describe a schedule the database
    // does not have and quietly push the hottest lead in the queue back.
    it("prefills today for a reply, which is due now", async () => {
      const user = setupUser();
      renderComposer([OPEN_DEAL]);

      await chooseKind(user, "DM received");
      await log(user);
      await screen.findByRole("group", { name: /follow-up/i });

      const when = screen.getByLabelText(/when/i) as HTMLInputElement;
      expect(dayOf(when.value)).toBe(dayFromNow(0));
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
      // Settle FIRST, then assert the absence. `addActivity` having been
      // called is not the same as the resulting render having landed, and a
      // negative assertion taken mid-flight passes for the wrong reason.
      await expectComposerStillUsable();
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
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
      // Settle FIRST, then assert the absence. `addActivity` having been
      // called is not the same as the resulting render having landed, and a
      // negative assertion taken mid-flight passes for the wrong reason.
      await expectComposerStillUsable();
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
    });

    // The third conjunct of `CLOCK_ELIGIBLE_SQL` (#251): `setNextAction`
    // refuses a voided deal with `VoidedOpportunityError`, and a voided deal
    // is still listed on this page, so it would otherwise reach this prompt.
    it("does not offer a deal that has been voided", async () => {
      const user = setupUser();
      const voided = opportunity({
        id: "eeee5555-0000-0000-0000-000000000000",
        stage: "qualified",
        product: "mark8ly",
        voidedAt: "2026-09-01T10:00:00.000Z",
      });
      renderComposer([voided]);

      await chooseKind(user, "Call");
      await log(user);

      await waitFor(() => expect(addActivity).toHaveBeenCalled());
      await expectComposerStillUsable();
      expect(screen.queryByRole("group", { name: /follow-up/i })).toBeNull();
    });
  });
});
