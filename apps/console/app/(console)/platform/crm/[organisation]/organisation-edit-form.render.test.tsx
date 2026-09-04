import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNSAFE_WEBSITE_URL_MESSAGE } from "@/lib/db/crm-url";
import type { OrganisationRow } from "@/lib/db/crm-repo";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  updateOrganisationAction: vi.fn(),
}));

import { updateOrganisationAction } from "./actions";
import { OrganisationEditForm } from "./organisation-edit-form";

const ORGANISATION: OrganisationRow = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Bondi Baker",
  websiteUrl: "https://bondibaker.example",
  location: "Sydney, Australia",
  // What `countryFromLocation` derives from the location above; the form does
  // not edit it (the write path re-derives it from the new location).
  country: "AU",
  category: ["bakery", "cafe"],
  tags: ["instagram", "warm"],
  convertedProduct: null,
  convertedLabel: null,
  convertedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Radix marks the rest of the document inert while a modal dialog is open by
// setting `pointer-events: none` on `document.body`. userEvent refuses to
// click through that by default, so every click inside the dialog would fail
// for a reason that has nothing to do with the component under test.
function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

/** Opens the dialog. Every assertion here is about the form inside it. */
async function openForm(
  user: ReturnType<typeof userEvent.setup>,
  organisation: OrganisationRow = ORGANISATION,
) {
  render(<OrganisationEditForm organisation={organisation} />);
  await user.click(screen.getByRole("button", { name: /edit organisation/i }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
}

/** The `FormData` the one call to the action was given. */
function submitted(): FormData {
  const calls = vi.mocked(updateOrganisationAction).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][1];
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /save changes/i }));
}

describe("OrganisationEditForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateOrganisationAction).mockResolvedValue({ ok: true });
  });

  it("names its dialog and can be dismissed from the keyboard", async () => {
    const user = setupUser();
    await openForm(user);

    expect(screen.getByRole("dialog", { name: /edit bondi baker/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("pre-fills every editable field from the current row", async () => {
    const user = setupUser();
    await openForm(user);

    expect(screen.getByLabelText("Organisation name")).toHaveValue("Bondi Baker");
    expect(screen.getByLabelText("Location")).toHaveValue("Sydney, Australia");
    expect(screen.getByLabelText("Website")).toHaveValue("https://bondibaker.example");

    const categories = screen.getByRole("list", { name: /category values/i });
    expect(within(categories).getByText("bakery")).toBeInTheDocument();
    expect(within(categories).getByText("cafe")).toBeInTheDocument();

    const tags = screen.getByRole("list", { name: /tag values/i });
    expect(within(tags).getByText("instagram")).toBeInTheDocument();
    expect(within(tags).getByText("warm")).toBeInTheDocument();
  });

  // `updateOrganisation` is a full replacement of the five editable fields,
  // not a patch: any field the form omits is cleared in the database. A save
  // after a one-field edit must therefore still carry the other four.
  it("submits all five fields even when only the name was edited", async () => {
    const user = setupUser();
    await openForm(user);

    await user.clear(screen.getByLabelText("Organisation name"));
    await user.type(screen.getByLabelText("Organisation name"), "Bondi Bakery");
    await save(user);

    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    const formData = submitted();
    expect(formData.get("name")).toBe("Bondi Bakery");
    expect(formData.get("location")).toBe("Sydney, Australia");
    expect(formData.get("websiteUrl")).toBe("https://bondibaker.example");
    expect(formData.getAll("category")).toEqual(["bakery", "cafe"]);
    expect(formData.getAll("tags")).toEqual(["instagram", "warm"]);
  });

  // The action reads these two with `formData.getAll`. One comma-joined
  // input would be stored as a single literal value containing commas.
  it("submits each tag as its own field, never one comma-joined value", async () => {
    const user = setupUser();
    await openForm(user);
    await save(user);

    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    expect(submitted().getAll("tags")).toEqual(["instagram", "warm"]);
    expect(submitted().get("tags")).not.toBe("instagram,warm");
  });

  it("adds a tag typed and committed with Enter", async () => {
    const user = setupUser();
    await openForm(user);

    await user.type(screen.getByLabelText("Tags"), "referral{Enter}");
    expect(
      within(screen.getByRole("list", { name: /tag values/i })).getByText("referral"),
    ).toBeInTheDocument();

    await save(user);
    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    expect(submitted().getAll("tags")).toEqual(["instagram", "warm", "referral"]);
  });

  // Typing a tag and pressing Save without pressing Enter first is the
  // obvious operator mistake; silently dropping the value would be a data
  // loss the operator has no way to notice.
  it("submits a tag left uncommitted in the input", async () => {
    const user = setupUser();
    await openForm(user);

    await user.type(screen.getByLabelText("Tags"), "referral");
    await save(user);

    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    expect(submitted().getAll("tags")).toEqual(["instagram", "warm", "referral"]);
  });

  it("removes a tag", async () => {
    const user = setupUser();
    await openForm(user);

    await user.click(screen.getByRole("button", { name: /remove tag warm/i }));
    await save(user);

    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    expect(submitted().getAll("tags")).toEqual(["instagram"]);
  });

  it("clears a field the operator emptied", async () => {
    const user = setupUser();
    await openForm(user);

    await user.clear(screen.getByLabelText("Location"));
    await user.click(screen.getByRole("button", { name: /remove category bakery/i }));
    await user.click(screen.getByRole("button", { name: /remove category cafe/i }));
    await save(user);

    await waitFor(() => expect(updateOrganisationAction).toHaveBeenCalled());
    expect(submitted().get("location")).toBe("");
    expect(submitted().getAll("category")).toEqual([]);
  });

  it("closes and refreshes the page on success", async () => {
    const user = setupUser();
    await openForm(user);
    await save(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("refuses a blank name without calling the action", async () => {
    const user = setupUser();
    await openForm(user);

    await user.clear(screen.getByLabelText("Organisation name"));
    await save(user);

    expect(updateOrganisationAction).not.toHaveBeenCalled();
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("Enter an organisation name.");
    expect(screen.getByLabelText("Organisation name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Organisation name")).toHaveAttribute(
      "aria-describedby",
      message.id,
    );
  });

  it("shows an unsafe website url against the website field", async () => {
    const user = setupUser();
    vi.mocked(updateOrganisationAction).mockResolvedValue({
      ok: false,
      message: UNSAFE_WEBSITE_URL_MESSAGE,
    });
    await openForm(user);
    await save(user);

    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent(UNSAFE_WEBSITE_URL_MESSAGE);
    const website = screen.getByLabelText("Website");
    expect(website).toHaveAttribute("aria-invalid", "true");
    expect(website).toHaveAttribute("aria-describedby", message.id);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows any other failure in a callout and keeps the dialog open", async () => {
    const user = setupUser();
    vi.mocked(updateOrganisationAction).mockResolvedValue({
      ok: false,
      message: "You do not have permission to write to the CRM.",
      });
    await openForm(user);
    await save(user);

    expect(
      await screen.findByText("You do not have permission to write to the CRM."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers empty fields for an organisation with nothing recorded", async () => {
    const user = setupUser();
    await openForm(user, {
      ...ORGANISATION,
      websiteUrl: null,
      location: null,
      category: [],
      tags: [],
    });

    expect(screen.getByLabelText("Location")).toHaveValue("");
    expect(screen.getByLabelText("Website")).toHaveValue("");
    expect(screen.queryByRole("list", { name: /tag values/i })).toBeNull();
  });
});
