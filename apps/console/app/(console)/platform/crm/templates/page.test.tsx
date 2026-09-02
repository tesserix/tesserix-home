import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MERGE_FIELDS } from "@/lib/crm-merge-fields";
import type { TemplateRow } from "@/lib/db/crm-templates";

const listTemplates = vi.fn();

vi.mock("@/lib/db/crm-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-templates")>()),
  listTemplates: (...args: unknown[]) => listTemplates(...args),
}));

// `templates-view.tsx`'s create form and per-row "Archive" call `useRouter()`
// to refresh after a server action — same reason `suppressions/page.test.tsx`
// mocks this.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import CrmTemplatesPage, { templatesState, EMPTY_MESSAGE } from "./page";

const ROW: TemplateRow = {
  id: "t1",
  name: "Bondi cafés — first touch",
  channel: "dm",
  product: null,
  subject: null,
  body: "Hi {{contact.name}} — I came across {{org.name}}",
  isArchived: false,
  createdBy: "ava@tesserix.app",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  listTemplates.mockReset();
});

async function renderPage() {
  render(await CrmTemplatesPage());
}

describe("templatesState", () => {
  it("reports empty — not ready — when nothing has been authored", () => {
    expect(templatesState({ error: null, rows: [] })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is at least one template", () => {
    expect(templatesState({ error: null, rows: [ROW] })).toEqual({ kind: "ready" });
  });

  it("prefers the error over an empty list", () => {
    // A failed read also has no rows. "No templates yet" would send an
    // operator off to author a duplicate of something that already exists —
    // the same distinction `suppressionsState` makes one surface over.
    expect(templatesState({ error: new Error("boom"), rows: [] }).kind).toBe("error");
  });
});

describe("EMPTY_MESSAGE", () => {
  it("is the copy the page actually ships, exported so a test can assert on it rather than a second copy of it", () => {
    expect(EMPTY_MESSAGE).toBe("No templates yet.");
  });
});

describe("CrmTemplatesPage", () => {
  it("renders the empty state, not a list, when nothing has been authored", async () => {
    listTemplates.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByText(EMPTY_MESSAGE)).toBeInTheDocument();
  });

  // The authoring form is the point of the surface, so it must be present in
  // EVERY state — including the empty one, which is the state an operator
  // reaches this page in on day one. A form rendered only alongside `ready`
  // rows would make the first template impossible to write.
  it("offers the authoring form even with nothing on the list", async () => {
    listTemplates.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save template" })).toBeInTheDocument();
  });

  it("renders each template's name, body and archive control once the list has rows", async () => {
    listTemplates.mockResolvedValue([ROW]);

    await renderPage();

    expect(screen.getByText("Bondi cafés — first touch")).toBeInTheDocument();
    expect(
      screen.getByText("Hi {{contact.name}} — I came across {{org.name}}"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  /**
   * The six tokens, on screen, sourced from the registry.
   *
   * `{{contact.instagram_handle}}` is not a string anybody guesses — and
   * `parseMergeFields` refuses everything outside the allowlist. Without this
   * list the surface teaches its own vocabulary one rejection at a time.
   *
   * Iterating `MERGE_FIELDS` rather than listing six literals: a hand-copied
   * expectation would keep passing against a legend that had gone stale, which
   * is the exact failure the component avoids by reading the registry.
   */
  it("prints every merge field in the registry, with its operator-facing label", async () => {
    listTemplates.mockResolvedValue([]);

    await renderPage();

    for (const [token, field] of Object.entries(MERGE_FIELDS)) {
      expect(screen.getByText(`{{${token}}}`), `token ${token}`).toBeInTheDocument();
      expect(screen.getByText(field.label), `label for ${token}`).toBeInTheDocument();
    }
    // Guards the guard: an empty registry would satisfy the loop above.
    expect(Object.keys(MERGE_FIELDS)).toHaveLength(6);
  });

  // The subject field mirrors `crm_template_subject_is_email_only`: a subject
  // on a DM is refused by the database, so offering the input while the
  // channel is `dm` — the default — would be an invitation to a rejection the
  // operator cannot see the reason for.
  it("hides the subject field while the channel is a DM", async () => {
    listTemplates.mockResolvedValue([]);

    await renderPage();

    expect(screen.queryByLabelText("Subject")).toBeNull();
  });

  // The same failure `suppressions/page.test.tsx` guards, one surface over: a
  // failed read and an empty list produce the same `rows: []`, and only the
  // page's own try/catch tells them apart. Rendering "No templates yet" during
  // an outage sends an operator to author a duplicate of copy that already
  // exists — and the raw pg text must not leak either.
  it("renders an error, not the empty-list message, when the read fails", async () => {
    listTemplates.mockRejectedValue(new Error("connection terminated"));

    await renderPage();

    expect(screen.queryByText("connection terminated")).toBeNull();
    expect(screen.getByText(/could not load the lead templates/i)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });
});
