import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrganisationDetail } from "@/lib/db/crm-repo";

const organisationDetail = vi.fn();

vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  organisationDetail: (...args: unknown[]) => organisationDetail(...args),
}));

const getCurrentSession = vi.fn();

// `hasCapability` itself is NOT mocked — the real implementation from
// `@tesserix/platform-auth` is what decides whether the erase/delete
// controls render, and a passing test should be evidence about that
// decision, not about a stand-in for it.
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: (...args: unknown[]) => getCurrentSession(...args),
}));

// Forces the `hard-delete` gate to actually check roles rather than the
// pre-cutover "every session holds every capability" bypass — same reason
// `tickets/[id]/page.test.tsx` doesn't need this (it mocks `hasCapability`
// directly instead).
vi.mock("@/lib/internal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/internal-access")>()),
  requiresCapability: () => true,
}));

// `EraseContactButton`/`DeleteOrganisationButton` call `useRouter()` to
// refresh/redirect after a server action — same reason `crm/page.test.tsx`
// and `suppressions/page.test.tsx` mock this.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import OrganisationDetailPage, { detailState, isUuidShaped } from "./page";

const DETAIL = {
  organisation: { id: "g1", name: "Bondi Baker" },
  contacts: [],
  opportunities: [],
  activities: [],
} as unknown as OrganisationDetail;

const ORG_ID = "8b6a7a4a-0000-0000-0000-000000000000";

const DETAIL_WITH_CONTACT = {
  organisation: {
    id: ORG_ID,
    name: "Glebe Flowers",
    websiteUrl: null,
    location: null,
    country: null,
    category: [],
    tags: [],
    convertedAt: null,
    convertedLabel: null,
    convertedProduct: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  contacts: [
    { id: "contact-1", name: "Priya Raman", email: null, phone: null, instagramHandle: null, isPrimary: true },
  ],
  opportunities: [],
  activities: [],
} as unknown as OrganisationDetail;

async function renderOrganisationPage(
  roles: readonly string[] | undefined,
  organisation: Record<string, unknown> = {},
) {
  organisationDetail.mockResolvedValue({
    ...DETAIL_WITH_CONTACT,
    organisation: { ...DETAIL_WITH_CONTACT.organisation, ...organisation },
  });
  getCurrentSession.mockResolvedValue({
    sub: "op-1",
    email: "op@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  });
  render(await OrganisationDetailPage({ params: Promise.resolve({ organisation: ORG_ID }) }));
}

describe("detailState", () => {
  it("reports empty — not ready — when the record never arrived", () => {
    expect(detailState({ error: null, detail: null })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is a record", () => {
    expect(detailState({ error: null, detail: DETAIL })).toEqual({ kind: "ready" });
  });

  it("prefers the error over the missing record", () => {
    // A thrown lookup also has no detail; "this record has no details" would
    // tell an operator the organisation is blank when the read simply failed.
    expect(detailState({ error: new Error("boom"), detail: null }).kind).toBe("error");
  });
});

// Minor 10: `crm_organisations.id` is a `uuid` column — a non-UUID path
// segment (a mistyped or hand-edited URL) previously reached the query and
// came back as Postgres error 22P02 ("invalid input syntax for type uuid"),
// which `detailState` has no choice but to read as a generic `error` state.
// That is the wrong outcome for what is actually a 404: the record doesn't
// exist because no record could ever have that id. `isUuidShaped` is the
// route-boundary check that catches this before the query runs at all.
describe("isUuidShaped", () => {
  it("accepts a real uuid", () => {
    expect(isUuidShaped("8b6a7a4a-0000-0000-0000-000000000000")).toBe(true);
  });

  it("accepts a uuid regardless of case", () => {
    expect(isUuidShaped("8B6A7A4A-0000-0000-0000-000000000000")).toBe(true);
  });

  it("rejects a non-uuid path segment — the case that used to hit Postgres error 22P02", () => {
    expect(isUuidShaped("nope")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isUuidShaped("")).toBe(false);
  });

  it("rejects a uuid-length string with an invalid character", () => {
    expect(isUuidShaped("8b6a7a4a-0000-0000-0000-00000000000z")).toBe(false);
  });
});

// Important 3 (fix round 1): the `canHardDelete` gate at page.tsx and the
// typed-name gate in organisation-detail-view.tsx are the two controls
// standing between an operator and an irreversible destroy — nothing was
// asserting either survives a refactor.
describe("hard-delete controls on the organisation detail page", () => {
  it("hides the Erase and Delete organisation controls for a session without hard-delete", async () => {
    await renderOrganisationPage(["read"]);

    expect(screen.queryByRole("button", { name: "Delete organisation" })).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Contacts" }));
    expect(screen.queryByRole("button", { name: "Erase" })).toBeNull();
  });

  it("shows the Erase and Delete organisation controls for a session with hard-delete", async () => {
    await renderOrganisationPage(["hard-delete"]);

    expect(screen.getByRole("button", { name: "Delete organisation" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Contacts" }));
    expect(screen.getByRole("button", { name: "Erase" })).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until the typed organisation name matches, case-insensitively", async () => {
    const user = userEvent.setup();
    await renderOrganisationPage(["hard-delete"]);

    await user.click(screen.getByRole("button", { name: "Delete organisation" }));

    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Delete organisation" });
    expect(confirmButton).toBeDisabled();

    const input = within(dialog).getByLabelText(/Type Glebe Flowers to confirm/i);
    await user.type(input, "glebe flowers");
    expect(confirmButton).not.toBeDisabled();

    await user.clear(input);
    await user.type(input, "not the org name");
    expect(confirmButton).toBeDisabled();
  });
});

/**
 * `country` is computed from `location`, never collected, so the rail has to
 * say whether the mapper resolved it. The wording is the point: an absent
 * value here is "Not derived", not the rail's usual "Not recorded", because
 * nobody ever fills this field in.
 */
describe("the derived country on the organisation summary rail", () => {
  function railValue(label: string): string {
    return screen.getByText(label).parentElement?.textContent ?? "";
  }

  it("shows the country label for an organisation the mapper resolved", async () => {
    await renderOrganisationPage(["read"], { location: "Chennai", country: "IN" });

    expect(railValue("Country")).toContain("India");
  });

  it("says Not derived — not Not recorded — when the location mapped to nothing", async () => {
    await renderOrganisationPage(["read"], { location: "Somewhere Unmapped", country: null });

    // The location IS recorded; it is the derivation that produced nothing,
    // and the two absences must not read the same.
    expect(railValue("Location")).toContain("Somewhere Unmapped");
    expect(railValue("Country")).toContain("Not derived");
  });

  it("falls back to the stored code when there is no label for it", async () => {
    await renderOrganisationPage(["read"], { location: "Auckland", country: "NZ" });

    expect(railValue("Country")).toContain("NZ");
  });
});
