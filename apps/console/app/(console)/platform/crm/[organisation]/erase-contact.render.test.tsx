import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactRow } from "@/lib/db/crm-repo";

/**
 * What an operator is told when an erasure commits but does not finish (#507).
 *
 * `eraseContact` cannot destroy the body of a DM the operator EDITED before
 * sending — that text is what a human actually wrote, and the quoted biography
 * inside it has no boundary a machine could cut along. It flags those rows
 * instead and reports how many. Three surfaces carry that fact; this file
 * covers the third, the one that reaches a person while the request is still
 * in their hands. (The other two — the `metadata.erasure_pending_review` stamp
 * and the `pending_redaction` audit count — are proven in
 * `lib/db/crm-outreach.integration.test.ts` and `actions.test.ts` against a
 * real database and a real audit write.)
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN. The durable surfaces are the guarantee;
 * this one is the only one with a deadline attached to it, because it is the
 * only one an operator is certain to be looking at. The failure it guards
 * against is not a crash — it is the dialog closing on a successful-looking
 * erasure that is not, in fact, honoured, which is invisible in every other
 * assertion in this repository.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  addContactAction: vi.fn(),
  eraseContactAction: vi.fn(),
}));

import { eraseContactAction } from "./actions";
import { ContactsTab } from "./organisation-detail-view";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ORG_NAME = "Flour & Ash";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";

const CONTACT: ContactRow = {
  id: CONTACT_ID,
  name: "Ada",
  email: "ada@example.com",
  phone: null,
  instagramHandle: "@ada",
  isPrimary: true,
  source: "manual",
  sourcedAt: "2026-05-01T00:00:00.000Z",
  lawfulBasis: "legitimate_interests",
};

beforeEach(() => {
  vi.clearAllMocks();
});

function renderTab() {
  return render(
    <ContactsTab
      organisationId={ORG_ID}
      organisationName={ORG_NAME}
      contacts={[CONTACT]}
      canHardDelete
    />,
  );
}

/** Through the typed-name gate and the confirm, exactly as an operator does. */
async function erase(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Erase" }));
  await user.type(screen.getByLabelText(/Type/), ORG_NAME);
  await user.click(screen.getByRole("button", { name: "Erase contact" }));
}

describe("erasing a contact with outreach that could not be finished", () => {
  it("stops the operator with a notice naming how many rows still need redacting", async () => {
    const user = userEvent.setup();
    vi.mocked(eraseContactAction).mockResolvedValue({ ok: true, pendingRedaction: 2 });
    renderTab();

    await erase(user);

    await waitFor(() => {
      expect(screen.getByText("This erasure is not finished")).toBeInTheDocument();
    });
    // The count, and the contact id needed to run the runbook query. Asserted
    // because a notice that only said "some messages" would send the operator
    // to the runbook with nothing to put in it.
    expect(screen.getByText(/2 logged messages/)).toBeInTheDocument();
    expect(screen.getByText(CONTACT_ID)).toBeInTheDocument();

    // The erasure DID commit, so the page must reflect it — telling the
    // operator about the residual is not a reason to leave the person's
    // details on screen.
    expect(refresh).toHaveBeenCalled();
  });

  it("offers no way to dismiss the notice except acknowledging it", async () => {
    // There is nothing to cancel: the erasure already committed. A "Cancel"
    // here would imply an undo that does not exist, and a notice that can be
    // waved away with the same reflex as a confirmation dialog is not a
    // notice.
    const user = userEvent.setup();
    vi.mocked(eraseContactAction).mockResolvedValue({ ok: true, pendingRedaction: 1 });
    renderTab();

    await erase(user);
    await waitFor(() => {
      expect(screen.getByText("This erasure is not finished")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    // Singular, because "1 messages were kept" reads as a bug and an operator
    // who thinks the notice is broken discounts what it says.
    expect(
      screen.getByText(/1 logged message an operator edited before sending was kept/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I will redact them" }));
    await waitFor(() => {
      expect(screen.queryByText("This erasure is not finished")).not.toBeInTheDocument();
    });
  });

  it("says nothing extra when the erasure was complete", async () => {
    // The negative control. Without it the two tests above would still pass on
    // a component that showed the notice unconditionally — which would train
    // operators to click through it, destroying the value of the times it is
    // real.
    const user = userEvent.setup();
    vi.mocked(eraseContactAction).mockResolvedValue({ ok: true, pendingRedaction: 0 });
    renderTab();

    await erase(user);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText("This erasure is not finished")).not.toBeInTheDocument();
  });

  it("shows the failure message, and no residual notice, when the erasure was refused", async () => {
    const user = userEvent.setup();
    vi.mocked(eraseContactAction).mockResolvedValue({
      ok: false,
      message: "This contact was NOT erased. CRM_ERASURE_HASH_KEY is not configured.",
    });
    renderTab();

    await erase(user);

    await waitFor(() => {
      expect(screen.getByText(/CRM_ERASURE_HASH_KEY/)).toBeInTheDocument();
    });
    // Nothing was erased, so there is no residual to report — and claiming one
    // would send an operator hunting for rows that are not there while the
    // real failure (a refused erasure) went unread.
    expect(screen.queryByText("This erasure is not finished")).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
