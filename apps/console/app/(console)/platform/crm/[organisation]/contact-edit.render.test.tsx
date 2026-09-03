import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactRow } from "@/lib/db/crm-repo";

/**
 * Correcting a contact from the detail page (#247).
 *
 * Until this existed the only way to fix a mistyped email was the DPDP
 * erasure path, which stamps `erased_at` and so records a request no data
 * subject made. The assertions here are about the two things that make the
 * edit form an actual replacement for that: it is seeded from the contact as
 * it stands, and it cannot be used to empty a contact of every identifying
 * field.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  addContactAction: vi.fn(),
  eraseContactAction: vi.fn(),
  updateContactAction: vi.fn(),
  setPrimaryContactAction: vi.fn(),
}));

import { setPrimaryContactAction, updateContactAction } from "./actions";
import { ContactsTab } from "./organisation-detail-view";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY: ContactRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ada",
  email: "ada@example.com",
  phone: null,
  instagramHandle: "ada",
  isPrimary: true,
};
const SECONDARY: ContactRow = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Grace",
  email: null,
  phone: null,
  instagramHandle: "grace",
  isPrimary: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateContactAction).mockResolvedValue({ ok: true });
  vi.mocked(setPrimaryContactAction).mockResolvedValue({ ok: true });
});

function renderTab(contacts: readonly ContactRow[] = [PRIMARY, SECONDARY]) {
  return render(
    <ContactsTab
      organisationId={ORG_ID}
      organisationName="Flour & Ash"
      contacts={contacts}
      canHardDelete={false}
    />,
  );
}

async function openEditorFor(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  name: string,
) {
  await user.click(screen.getAllByRole("button", { name: "Edit" })[index]);
  // Scoped to the named form: the ADD-contact form carries the same four
  // labels, so an unscoped getByLabelText("Email") finds it instead and every
  // assertion below would be about the wrong form.
  return within(screen.getByRole("form", { name: `Edit ${name}` }));
}

describe("editing a contact", () => {
  // Collapsed by default: an organisation can have several contacts, and four
  // always-open inputs per row would bury the thing an operator came to read.
  it("shows no form until an operator asks for one", () => {
    renderTab();
    expect(screen.queryByRole("form", { name: /^Edit / })).not.toBeInTheDocument();
  });

  // Seeded, not blank. A blank form makes clearing a field the DEFAULT — an
  // operator fixing a phone number would silently wipe the email by not
  // retyping it, which is the same data loss the erasure workaround caused.
  it("seeds the form from the contact as it stands", async () => {
    const user = userEvent.setup();
    renderTab([PRIMARY]);

    const form = await openEditorFor(user, 0, "Ada");

    expect(form.getByLabelText("Name")).toHaveValue("Ada");
    expect(form.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(form.getByLabelText("Instagram handle")).toHaveValue("ada");
  });

  it("sends the edited fields for that contact", async () => {
    const user = userEvent.setup();
    renderTab([PRIMARY]);
    const form = await openEditorFor(user, 0, "Ada");

    await user.clear(form.getByLabelText("Email"));
    await user.type(form.getByLabelText("Email"), "ada@newdomain.example");
    await user.click(form.getByRole("button", { name: "Save contact" }));

    await waitFor(() => expect(updateContactAction).toHaveBeenCalled());
    const [organisationId, contactId, formData] = vi.mocked(updateContactAction).mock.calls[0];
    expect(organisationId).toBe(ORG_ID);
    expect(contactId).toBe(PRIMARY.id);
    expect((formData as FormData).get("email")).toBe("ada@newdomain.example");
    // The untouched fields travel too: the action replaces all four, so an
    // omitted one would be a clear, not a no-op.
    expect((formData as FormData).get("name")).toBe("Ada");
  });

  // Editing is the one path that can reach "every identifying field cleared"
  // from a valid row — the create form cannot, because it has nothing to
  // clear. Gated in the UI as well as the action.
  it("refuses to save a contact emptied of every identifying field", async () => {
    const user = userEvent.setup();
    renderTab([PRIMARY]);
    const form = await openEditorFor(user, 0, "Ada");

    for (const label of ["Name", "Email", "Phone", "Instagram handle"]) {
      await user.clear(form.getByLabelText(label));
    }

    expect(form.getByRole("button", { name: "Save contact" })).toBeDisabled();
    expect(updateContactAction).not.toHaveBeenCalled();
  });

  it("surfaces a refusal rather than closing on it", async () => {
    const user = userEvent.setup();
    vi.mocked(updateContactAction).mockResolvedValue({
      ok: false,
      message: "A contact with that email address is already in the CRM.",
    });
    renderTab([PRIMARY]);
    const form = await openEditorFor(user, 0, "Ada");

    await user.click(form.getByRole("button", { name: "Save contact" }));

    expect(await screen.findByText(/already in the CRM/)).toBeInTheDocument();
    // Still open: closing on a refusal would lose what the operator typed.
    expect(screen.getByRole("form", { name: "Edit Ada" })).toBeInTheDocument();
  });
});

describe("changing which contact is primary", () => {
  // Offered only where it means something. On the contact that is already
  // primary the control would be a no-op dressed as an action.
  it("offers the promotion only on a contact that is not already primary", () => {
    renderTab();
    expect(screen.getAllByRole("button", { name: "Make primary" })).toHaveLength(1);
  });

  it("promotes the contact it sits beside", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("button", { name: "Make primary" }));

    await waitFor(() => expect(setPrimaryContactAction).toHaveBeenCalledWith(ORG_ID, SECONDARY.id));
  });
});
