import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(console)/platform/tools/actions", () => ({
  addToolAction: vi.fn(async () => ({ ok: true })),
  editToolAction: vi.fn(async () => ({ ok: true })),
  removeToolAction: vi.fn(async () => ({ ok: true })),
  moveToolAction: vi.fn(async () => ({ ok: true })),
  addGroupAction: vi.fn(async () => ({ ok: true })),
  renameGroupAction: vi.fn(async () => ({ ok: true })),
  removeGroupAction: vi.fn(async () => ({ ok: true })),
  moveGroupAction: vi.fn(async () => ({ ok: true })),
}));

import { addToolAction, removeToolAction } from "@/app/(console)/platform/tools/actions";
import { ToolsManager } from "./tools-manager";
import type { ToolsDirectory } from "@/lib/tools-directory";

const DIRECTORY: ToolsDirectory = {
  source: "platform-api",
  groups: [
    { key: "identity", label: "Identity and secrets", sortOrder: 10 },
    { key: "empty", label: "Nothing here yet", sortOrder: 20 },
  ],
  tools: [
    {
      id: "t1", name: "Zitadel", subdomain: "auth", purpose: "Identity platform.",
      note: null, groupKey: "identity", sortOrder: 10,
    },
    {
      id: "t2", name: "Secret service", subdomain: "secret-service", purpose: "Secrets.",
      note: "Separate login.", groupKey: "identity", sortOrder: 20,
    },
  ],
};

afterEach(() => vi.resetAllMocks());

describe("ToolsManager", () => {
  it("shows an empty group rather than hiding it", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    // The home page skips empty groups; this surface must not. A group you
    // just created is empty, and hiding it makes creation look like it failed.
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText(/no tools in this group yet/i)).toBeInTheDocument();
  });

  it("renders a tool's note where it has one", () => {
    render(<ToolsManager directory={DIRECTORY} />);
    expect(screen.getByText("Separate login.")).toBeInTheDocument();
  });

  it("adds a tool through the action", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Tempo");
    await user.type(screen.getByLabelText(/subdomain/i), "tempo");
    await user.type(screen.getByLabelText(/purpose/i), "Distributed traces.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Tempo", subdomain: "tempo", purpose: "Distributed traces.",
      }),
    );
  });

  it("sends an empty note as null rather than an empty string", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Tempo");
    await user.type(screen.getByLabelText(/subdomain/i), "tempo");
    await user.type(screen.getByLabelText(/purpose/i), "Traces.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addToolAction).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it("puts a field-scoped refusal under the field it names", async () => {
    const user = userEvent.setup();
    vi.mocked(addToolAction).mockResolvedValue({
      ok: false,
      message: "a subdomain must be a single DNS label",
      field: "subdomain",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getAllByRole("button", { name: /add tool/i })[0]);
    await user.type(screen.getByLabelText(/name/i), "Bad");
    await user.type(screen.getByLabelText(/subdomain/i), "https://x.example");
    await user.type(screen.getByLabelText(/purpose/i), "x");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Beside the input, not at the top of the form — the whole point of the
    // seam carrying `field`. Asserted as the accessibility property that
    // matters (the field is programmatically described as invalid), not as
    // a DOM ancestor relationship only one particular markup shape satisfies.
    const subdomain = screen.getByLabelText(/subdomain/i);
    expect(subdomain).toHaveAccessibleDescription(/single DNS label/i);
    expect(subdomain).toBeInvalid();
  });

  it("confirms before deleting, and names the tool", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /^delete$/i }));

    // A confirmation that does not name the thing is a confirmation nobody
    // reads.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Zitadel/)).toBeInTheDocument();
    expect(removeToolAction).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /^delete tool$/i }));
    expect(removeToolAction).toHaveBeenCalledWith("t1");
  });

  it("shows the write's own refusal when a delete fails", async () => {
    const user = userEvent.setup();
    vi.mocked(removeToolAction).mockResolvedValue({
      ok: false,
      message: "You do not have permission to change the tools directory.",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /^delete$/i }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete tool$/i }));

    expect(within(dialog).getByText(/do not have permission/i)).toBeInTheDocument();
  });
});
