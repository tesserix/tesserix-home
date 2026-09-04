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
  skippedErased: 0,
  malformed: 0,
  matchedRows: [],
};

function committedResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    importId: "11111111-1111-1111-1111-111111111111",
    created: 47,
    matchedExisting: 3,
    skippedSuppressed: 1,
    skippedErased: 0,
    malformed: 0,
    droppedWebsiteUrls: 0,
    droppedCountCells: 0,
    droppedMetadataCells: 0,
    matchedRows: [],
    ...overrides,
  };
}

/** Opens the batch lawful-basis Select and picks the option with that label.
 *  `pointerEventsCheck: 0` is the usual Radix accommodation — it marks the
 *  rest of the document inert while its listbox is open. */
async function chooseLawfulBasis(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: /lawful basis/i }));
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  await user.click(screen.getByRole("option", { name: label }));
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
  // #248: commit is gated on a lawful basis for the batch, so this flow has
  // to choose one — which is the point. Before this the button was reachable
  // with nothing declared.
  await chooseLawfulBasis(user, "Legitimate interests");
  await user.click(screen.getByRole("button", { name: "Commit import" }));

  await waitFor(() => expect(screen.getByText("Import committed")).toBeInTheDocument());
}

/**
 * #248 — the batch declares its lawful basis before it can be committed.
 *
 * Per batch and not per row, per the issue: a CSV of scraped profiles has one
 * answer to "why may we hold these people", and a column would ask the
 * operator to repeat one decision N times and let rows disagree.
 */
describe("ImportView lawful basis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function previewAFile(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(previewImportAction).mockResolvedValue({ ok: true, preview: PREVIEW });
    render(<ImportView />);
    const file = new File([CSV], "leads.csv", { type: "text/csv" });
    const input = document.getElementById("crm-import-file") as HTMLInputElement;
    await user.upload(input, file);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Commit import" })).toBeInTheDocument(),
    );
  }

  it("cannot commit until a basis is chosen, and never calls the action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await previewAFile(user);

    expect(screen.getByRole("button", { name: "Commit import" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Commit import" }));
    expect(commitImportAction).not.toHaveBeenCalled();
  });

  it("passes the chosen basis to the action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(commitImportAction).mockResolvedValue({ ok: true, result: committedResult() });
    await previewAFile(user);

    await chooseLawfulBasis(user, "Legitimate interests");
    await user.click(screen.getByRole("button", { name: "Commit import" }));

    await waitFor(() => expect(commitImportAction).toHaveBeenCalled());
    const [, basis] = vi.mocked(commitImportAction).mock.calls[0];
    expect(basis).toBe("legitimate_interests");
  });

  it("offers no option that records 'we do not know' going forward", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await previewAFile(user);

    await user.click(screen.getByRole("combobox", { name: /lawful basis/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    const options = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(options).toEqual(["Legitimate interests", "Consent", "Contract"]);
  });
});

describe("ImportView committed result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links to the organisations this import created", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
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
    const user = userEvent.setup({ pointerEventsCheck: 0 });
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
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ droppedWebsiteUrls: 2 }));

    expect(screen.getByText("Website dropped")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/website cell was not a http/i)).toBeInTheDocument();
  });

  it("offers no dropped-url explanation when every website url was fine", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ droppedWebsiteUrls: 0 }));

    expect(screen.getByText("Website dropped")).toBeInTheDocument();
    expect(screen.queryByText(/website cell was not a http/i)).toBeNull();
  });

  // #235: a followers/posts cell that was not a whole number is stored as
  // NULL, and the row is still created. Same remedy as a dropped website
  // url — correct the sheet and import again — so it needs the same telling.
  it("reports count cells the import dropped", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ droppedCountCells: 3 }));

    expect(screen.getByText("Counts dropped")).toBeInTheDocument();
    expect(screen.getByText(/follower or post count/i)).toBeInTheDocument();
  });

  it("offers no dropped-count explanation when every count cell was a whole number", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ droppedCountCells: 0 }));

    expect(screen.getByText("Counts dropped")).toBeInTheDocument();
    expect(screen.queryByText(/follower or post count/i)).toBeNull();
  });

  it("reports metadata cells the import dropped", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ droppedMetadataCells: 1 }));

    expect(screen.getByText("Metadata dropped")).toBeInTheDocument();
    expect(screen.getByText(/was not a JSON object/i)).toBeInTheDocument();
  });

  it("reports rows refused because the person asked to be forgotten (#226)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ skippedErased: 2 }));

    // Its own cell beside Suppressed, and its own note — the two counts have
    // opposite remedies, and the suppressed copy ("remove the suppression")
    // is advice an operator could act on for someone who asked to be erased.
    expect(screen.getByText("Erased")).toBeInTheDocument();
    expect(screen.getByText("Suppressed")).toBeInTheDocument();
    expect(screen.getByText(/asked to be forgotten/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not add them back by hand/i)).toBeInTheDocument();
  });

  it("shows the erased count as zero rather than hiding it when nothing was refused", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ skippedErased: 0 }));

    // A checked fact, not an unknown: the register is consulted on every
    // import, so the cell stays and only the explanatory note goes.
    expect(screen.getByText("Erased")).toBeInTheDocument();
    expect(screen.queryByText(/asked to be forgotten/i)).toBeNull();
  });

  it("offers no link when the import created nothing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await commitAnImport(user, committedResult({ created: 0, matchedExisting: 5, skippedSuppressed: 0 }));

    expect(screen.queryByRole("link", { name: /view/i })).toBeNull();
  });
});
