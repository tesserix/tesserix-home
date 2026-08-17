import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportResult } from "@/lib/db/crm-repo";

// `ImportView` takes no props — the committed result lives in its own
// `useState`, reached only by driving the real upload → preview → commit
// flow. So this mocks the two server actions it calls, not a `result` prop.
vi.mock("./actions", () => ({
  previewImportAction: vi.fn(),
  commitImportAction: vi.fn(),
}));

import { previewImportAction, commitImportAction } from "./actions";
import { ImportView } from "./import-view";

const CSV = "name\nAcme Co\n";

const PREVIEW = {
  toCreate: 1,
  matchedExisting: 0,
  skippedSuppressed: 0,
  malformed: 0,
  matchedRows: [],
};

function committedResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    importId: "11111111-1111-1111-1111-111111111111",
    created: 47,
    matchedExisting: 3,
    skippedSuppressed: 1,
    malformed: 0,
    droppedWebsiteUrls: 0,
    matchedRows: [],
    ...overrides,
  };
}

/** Uploads a CSV, previews it, and commits — the only path that ever puts
 *  `ImportView` into its committed state. */
async function commitAnImport(user: ReturnType<typeof userEvent.setup>, result: ImportResult) {
  vi.mocked(previewImportAction).mockResolvedValue({ ok: true, preview: PREVIEW });
  vi.mocked(commitImportAction).mockResolvedValue({ ok: true, result });

  render(<ImportView />);

  const file = new File([CSV], "leads.csv", { type: "text/csv" });
  const input = document.getElementById("crm-import-file") as HTMLInputElement;
  await user.upload(input, file);

  await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Preview" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Commit import" })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Commit import" }));

  await waitFor(() => expect(screen.getByText("Import committed")).toBeInTheDocument());
}

describe("ImportView committed result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links to the organisations this import created", async () => {
    const user = userEvent.setup();
    await commitAnImport(user, committedResult());

    // Without this the import flow is a dead end: it reports "47 created"
    // and offers no way to see any of them, and those rows are on neither
    // CRM queue for fourteen days.
    const link = screen.getByRole("link", { name: /view.*47/i });
    expect(link).toHaveAttribute(
      "href",
      "/platform/crm/organisations?import=11111111-1111-1111-1111-111111111111",
    );
  });

  it("says organisation, singular, when the import created exactly one", async () => {
    const user = userEvent.setup();
    await commitAnImport(user, committedResult({ created: 1 }));

    const link = screen.getByRole("link", { name: /view/i });
    expect(link).toHaveTextContent("View 1 new organisation");
    expect(link).not.toHaveTextContent("organisations");
  });

  // Finding 5: `commitImport` stores an unsafe website_url as NULL and keeps
  // the row. There is no organisation edit surface anywhere in the console,
  // so an operator who is not told cannot put the address back by hand — the
  // count is the only thing that makes a re-import a choice they can make.
  it("reports website urls the import dropped", async () => {
    const user = userEvent.setup();
    await commitAnImport(user, committedResult({ droppedWebsiteUrls: 2 }));

    expect(screen.getByText("Website dropped")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/website cell was not a http/i)).toBeInTheDocument();
  });

  it("offers no dropped-url explanation when every website url was fine", async () => {
    const user = userEvent.setup();
    await commitAnImport(user, committedResult({ droppedWebsiteUrls: 0 }));

    expect(screen.getByText("Website dropped")).toBeInTheDocument();
    expect(screen.queryByText(/website cell was not a http/i)).toBeNull();
  });

  it("offers no link when the import created nothing", async () => {
    const user = userEvent.setup();
    await commitAnImport(user, committedResult({ created: 0, matchedExisting: 5, skippedSuppressed: 0 }));

    expect(screen.queryByRole("link", { name: /view/i })).toBeNull();
  });
});
