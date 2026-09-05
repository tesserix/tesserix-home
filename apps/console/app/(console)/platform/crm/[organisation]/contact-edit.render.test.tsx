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
  followersCount: null,
  source: "manual",
  sourcedAt: "2026-05-01T00:00:00.000Z",
  lawfulBasis: "legitimate_interests",
};
const SECONDARY: ContactRow = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Grace",
  email: null,
  phone: null,
  instagramHandle: "grace",
  isPrimary: false,
  followersCount: null,
  source: "manual",
  sourcedAt: "2026-05-01T00:00:00.000Z",
  lawfulBasis: "legitimate_interests",
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
    // #248 is the exception to that rule, and deliberately so: an ABSENT
    // `lawfulBasis` means "leave the recorded one alone" all the way down to
    // `updateContact`'s COALESCE. Sending the current value instead would be
    // unsaveable for the 259 migrated rows, whose basis is storable but not
    // selectable.
    expect((formData as FormData).has("lawfulBasis")).toBe(false);
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

/**
 * #248 — provenance on the surface an operator answering a subject-access
 * request is already on.
 *
 * `crm_contacts.source`/`.sourced_at`/`.lawful_basis` are, in migration
 * 0019's words, "the justification for holding the data at all", and until
 * now nothing selected them: the answer to "why do you have my details" was
 * only available through psql.
 */
describe("contact provenance on the detail view", () => {
  const MIGRATED: ContactRow = {
    ...PRIMARY,
    id: "44444444-4444-4444-8444-444444444444",
    name: "Marguerite",
    source: "instagram_outreach",
    lawfulBasis: "not_recorded_pre_migration",
  };
  const UNRECORDED: ContactRow = {
    ...PRIMARY,
    id: "55555555-5555-4555-8555-555555555555",
    name: "Blank",
    source: null,
    sourcedAt: null,
    lawfulBasis: null,
  };

  /** The rendered provenance values, read off the `<dd>`s only. The
   *  add-contact form on the same page carries a hidden native `<select>`
   *  whose `<option>`s repeat the basis labels, so an unscoped text query
   *  matches the picker as well as the record. */
  function provenanceValues(): string[] {
    return Array.from(document.querySelectorAll("dd")).map(
      (node) => node.textContent ?? "",
    );
  }

  it("shows the lawful basis, the source and the date it was sourced", () => {
    renderTab([PRIMARY]);
    expect(provenanceValues()).toEqual([
      "Legitimate interests",
      "Added by hand",
      "2026-05-01",
    ]);
  });

  it("names a migrated row's basis as the pre-migration marker rather than hiding it", () => {
    renderTab([MIGRATED]);
    expect(provenanceValues()).toContain("Not recorded (pre-migration)");
    expect(provenanceValues()).toContain("Instagram outreach");
  });

  it("says 'Not recorded' rather than rendering nothing when provenance is absent", () => {
    // The state #248 found for every contact created between the cutover and
    // this fix. A block that vanished would hide the one case worth seeing.
    renderTab([UNRECORDED]);
    expect(provenanceValues()).toEqual(["Not recorded", "Not recorded", "Not recorded"]);
  });

  it("offers the three selectable bases when correcting, and never the legacy marker", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTab([MIGRATED]);
    const form = await openEditorFor(user, 0, "Marguerite");

    await user.click(form.getByRole("combobox", { name: /lawful basis/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

    const options = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(options).toEqual(
      expect.arrayContaining(["Legitimate interests", "Consent", "Contract"]),
    );
    // Offered only as the untouched CURRENT value, never as a choice.
    expect(options.filter((label) => /pre-migration/i.test(label))).toEqual([
      "Keep as recorded — Not recorded (pre-migration)",
    ]);
  });

  it("sends the corrected basis only when the operator picks one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTab([PRIMARY]);
    const form = await openEditorFor(user, 0, "Ada");

    await user.click(form.getByRole("combobox", { name: /lawful basis/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.click(screen.getByRole("option", { name: "Consent" }));
    await user.click(form.getByRole("button", { name: "Save contact" }));

    await waitFor(() => expect(updateContactAction).toHaveBeenCalled());
    const [, , formData] = vi.mocked(updateContactAction).mock.calls[0];
    expect((formData as FormData).get("lawfulBasis")).toBe("consent");
  });
});

describe("adding a contact by hand", () => {
  it("cannot be saved until a lawful basis is chosen (#248)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTab([PRIMARY]);

    await user.type(screen.getByLabelText("Name"), "Newcomer");
    // A name alone used to be enough. A contact created with no recorded
    // basis is the defect this issue reports, so the button stays disabled.
    expect(screen.getByRole("button", { name: "Add contact" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: /lawful basis/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.click(screen.getByRole("option", { name: "Consent" }));

    expect(screen.getByRole("button", { name: "Add contact" })).toBeEnabled();
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
