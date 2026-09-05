import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContactRow } from "@/lib/db/crm-repo";

/**
 * The follower count on the organisation detail page (#252 §A).
 *
 * The browse list bands and sorts organisations on this number, so an
 * operator arrives here having already filtered on it — and until now the
 * detail page showed every field about a contact except that one, which
 * meant the figure could not be confirmed against the contact it belongs to.
 *
 * The assertions below are the three things that make the number usable:
 * it says what it counts, since no column header does so here; it is compact
 * enough to sit on a line beside the email and handle, with the exact figure
 * still reachable; and an unrecorded count is absent rather than rendered as
 * `0`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  addContactAction: vi.fn(),
  eraseContactAction: vi.fn(),
  updateContactAction: vi.fn(),
  setPrimaryContactAction: vi.fn(),
}));

import { ContactsTab } from "./organisation-detail-view";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function contact(overrides: Partial<ContactRow> & Pick<ContactRow, "id" | "name">): ContactRow {
  return {
    email: null,
    phone: null,
    instagramHandle: null,
    isPrimary: false,
    followersCount: null,
    source: "manual",
    sourcedAt: "2026-05-01T00:00:00.000Z",
    lawfulBasis: "legitimate_interests",
    ...overrides,
  };
}

function renderContacts(contacts: readonly ContactRow[]) {
  render(
    <ContactsTab
      organisationId={ORG_ID}
      organisationName="Bondi Baker"
      contacts={contacts}
      canHardDelete={false}
    />,
  );
}

function rowFor(name: string): HTMLElement {
  const item = screen.getByText(name).closest("li");
  if (!item) throw new Error(`no contact row rendered for ${name}`);
  return item;
}

describe("contact follower count", () => {
  // The number names what it counts in its own text, not only in `title`.
  // No column header does that job on this page, and `title` is neither
  // keyboard-reachable nor reliably announced — so without this an operator
  // meets an unlabelled figure sitting between an email and an `@handle`.
  it("says what the number counts, in text rather than only on hover", () => {
    renderContacts([contact({ id: "c1", name: "Priya", followersCount: 12_400 })]);

    expect(within(rowFor("Priya")).getByText("12k followers")).toBeTruthy();
  });

  it("renders a recorded count compactly, with the exact figure still reachable", () => {
    renderContacts([contact({ id: "c1", name: "Priya", followersCount: 12_400 })]);

    const row = rowFor("Priya");
    const followers = within(row).getByTitle(`${(12_400).toLocaleString()} followers`);
    expect(followers.textContent).toBe("12k followers");
  });

  it("keeps the tenth of a thousand while it still means something", () => {
    renderContacts([contact({ id: "c1", name: "Priya", followersCount: 1240 })]);

    expect(within(rowFor("Priya")).getByTitle(/followers$/).textContent).toBe("1.2k followers");
  });

  // The non-negotiable. These rows have no recorded value, which is not the
  // claim a measured zero makes: an operator reading "0 followers" would
  // qualify a lead out on a number nobody ever collected. 51 of the 259
  // production contacts are in this state, so it is the common path.
  it("renders nothing at all for an unrecorded count, never a zero", () => {
    renderContacts([contact({ id: "c2", name: "Sam", followersCount: null })]);

    const row = rowFor("Sam");
    expect(within(row).queryByTitle(/followers$/)).toBeNull();
    // Not merely "no title": no follower text may reach the row either, or a
    // count rendered without its `title` would slip past the check above.
    // Matching on the word rather than on `0` alone is what survives the
    // label — `0 followers` is not the exact text `0`.
    expect(within(row).queryByText(/followers/)).toBeNull();
  });

  // A genuine zero is a measurement and reads as one — the distinction the
  // null case above exists to protect.
  it("renders a measured zero", () => {
    renderContacts([contact({ id: "c3", name: "Nil", followersCount: 0 })]);

    expect(within(rowFor("Nil")).getByTitle("0 followers").textContent).toBe("0 followers");
  });
});
