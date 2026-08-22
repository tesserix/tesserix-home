import { useState } from "react";
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

import {
  addToolAction,
  editToolAction,
  removeToolAction,
  addGroupAction,
  renameGroupAction,
  removeGroupAction,
  moveToolAction,
  moveGroupAction,
} from "@/app/(console)/platform/tools/actions";
import { ToolsManager } from "./tools-manager";
import type { ToolsDirectory } from "@/lib/tools-directory";

/**
 * Two populated groups (`identity`, `delivery`), one single-tool group
 * (`monitoring`), and one empty group (`empty`) — deliberately, not just
 * two tools in one group. With only one populated group, group-filtered
 * adjacency and global-array adjacency can never disagree, so a regression
 * to `directory.tools.findIndex(...) === 0 / length - 1` (ignoring group
 * boundaries) would pass every test unnoticed. Here `t2` (Secret service) is
 * last within `identity` but has a global successor (`t3`, in `delivery`),
 * and `t3` is first within `delivery` but has a global predecessor (`t2`, in
 * `identity`) — the two disagree, and only a correctly group-scoped
 * implementation gets both boundaries right.
 */
const DIRECTORY: ToolsDirectory = {
  source: "platform-api",
  groups: [
    { key: "identity", label: "Identity and secrets", sortOrder: 10 },
    { key: "delivery", label: "Delivery", sortOrder: 20 },
    { key: "monitoring", label: "Monitoring", sortOrder: 30 },
    { key: "empty", label: "Nothing here yet", sortOrder: 40 },
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
    {
      id: "t3", name: "ArgoCD", subdomain: "argocd", purpose: "What is deployed.",
      note: null, groupKey: "delivery", sortOrder: 10,
    },
    {
      id: "t4", name: "Kargo", subdomain: "kargo", purpose: "Promotes images.",
      note: null, groupKey: "delivery", sortOrder: 20,
    },
    {
      id: "t5", name: "Sentry", subdomain: "sentry", purpose: "Error tracking.",
      note: null, groupKey: "monitoring", sortOrder: 10,
    },
  ],
};

afterEach(() => vi.resetAllMocks());

// Set by the `Harness` component in the reopen-after-edit test below, so the
// mocked `editToolAction` can drive that component's state the way a real
// Next.js router refresh would drive `ToolsManager`'s `directory` prop.
let harnessSetDirectory: (
  update: (prev: ToolsDirectory) => ToolsDirectory,
) => void = () => {
  throw new Error("harnessSetDirectory used before Harness rendered");
};

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

    await user.click(screen.getByRole("button", { name: "Add tool to Identity and secrets" }));
    await user.type(screen.getByLabelText(/^name$/i), "Tempo");
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

    await user.click(screen.getByRole("button", { name: "Add tool to Identity and secrets" }));
    await user.type(screen.getByLabelText(/^name$/i), "Tempo");
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

    await user.click(screen.getByRole("button", { name: "Add tool to Identity and secrets" }));
    await user.type(screen.getByLabelText(/^name$/i), "Bad");
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
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Delete Zitadel" }));

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
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Delete Zitadel" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete tool$/i }));

    expect(within(dialog).getByText(/do not have permission/i)).toBeInTheDocument();
  });

  it("opens Edit prefilled with the tool's current values, and submits the change", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getByRole("button", { name: "Edit Zitadel" }));

    // Prefilled with t1's CURRENT values, not blank and not another row's —
    // this is the case finding 1 lived in: a form seeded only at mount would
    // still pass a first open, so the fixture's other tools exist precisely
    // so a wrong value would be a wrong value, not an absent one.
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Zitadel");
    expect(screen.getByLabelText(/subdomain/i)).toHaveValue("auth");
    expect(screen.getByLabelText(/purpose/i)).toHaveValue("Identity platform.");

    const purpose = screen.getByLabelText(/purpose/i);
    await user.clear(purpose);
    await user.type(purpose, "Auth, renamed.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(editToolAction).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ name: "Zitadel", purpose: "Auth, renamed." }),
    );
  });

  it("shows the NEW value on reopen after an edit, not the value it replaced", async () => {
    // `ToolsManager` only ever renders the `directory` prop it is given — in
    // the real app, a successful write's `revalidatePath` triggers a Next.js
    // router refresh that re-fetches the directory and hands this component
    // the UPDATED tool before the operator can reopen the dialog. `Harness`
    // stands in for that refresh: the mocked `editToolAction` updates its
    // state the same way a real refresh would update the prop.
    function Harness() {
      const [directory, setDirectory] = useState(DIRECTORY);
      harnessSetDirectory = setDirectory;
      return <ToolsManager directory={directory} />;
    }
    vi.mocked(editToolAction).mockImplementation(async (id, patch) => {
      harnessSetDirectory((prev) => ({
        ...prev,
        tools: prev.tools.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      }));
      return { ok: true };
    });

    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Edit Zitadel" }));
    const name = screen.getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, "Auth");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // `ToolRow` is keyed on `tool.id`, which an edit does not change, so the
    // form is reconciled rather than remounted between opens — the fix has to
    // re-seed on the trigger's own click, not rely on mount-time state, or
    // this would still show "Zitadel" here.
    await user.click(screen.getByRole("button", { name: "Edit Auth" }));
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Auth");
  });

  it("shows a message and leaves the dialog usable when the action call itself rejects", async () => {
    const user = userEvent.setup();
    vi.mocked(editToolAction).mockRejectedValue(new Error("network"));
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getByRole("button", { name: "Edit Zitadel" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(
      await screen.findByText(/not saved\. try again shortly/i),
    ).toBeInTheDocument();
    // Not stuck disabled: pending was cleared in a `finally`, so the form can
    // be retried.
    expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
  });
});

describe("group management", () => {
  it("adds a group", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    await user.click(screen.getByRole("button", { name: /add group/i }));
    await user.type(screen.getByLabelText(/^key$/i), "security");
    await user.type(screen.getByLabelText(/label/i), "Security");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(addGroupAction).toHaveBeenCalledWith({ key: "security", label: "Security" });
  });

  it("renames a group without offering to change its key", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    // The exact accessible name, not `within(section)` scoping on the shared
    // "Rename" text — every group renders one, and querying by name alone
    // disambiguates regardless of how many groups are on the page.
    await user.click(screen.getByRole("button", { name: "Rename Identity and secrets" }));

    // The key is a foreign key every tool in the group references. The API
    // refuses to change it with a 400 explaining the remedy; offering an
    // editable field here would invite that refusal on every rename.
    expect(screen.queryByLabelText(/^key$/i)).not.toBeInTheDocument();

    const input = screen.getByLabelText(/label/i);
    await user.clear(input);
    await user.type(input, "Identity");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(renameGroupAction).toHaveBeenCalledWith("identity", "Identity");
  });

  it("surfaces the API's refusal to delete a populated group", async () => {
    const user = userEvent.setup();
    vi.mocked(removeGroupAction).mockResolvedValue({
      ok: false,
      message: "Move or remove the tools in this group first.",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    // The header's own control has the visible text "Delete", same as every
    // ToolRow's, but its accessible name is "Delete Identity and secrets" —
    // an `aria-label` that leaves the rendered text untouched while making
    // the query unambiguous regardless of how many groups or tool rows are
    // on the page. The dialog's confirm button keeps its plain "Delete
    // group" name and is queried scoped to the dialog.
    await user.click(screen.getByRole("button", { name: "Delete Identity and secrets" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete group$/i }));

    expect(await screen.findByText(/move or remove the tools/i)).toBeInTheDocument();
  });
});

describe("reordering", () => {
  it("moves a tool down by swapping stored sort orders with the row below", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /move down/i }));

    // The fixture's REAL values — 10 and 20, deliberately not 1 and 2. An
    // implementation that passed render indices would call this with 1 and 2
    // and fail here, which is the whole point of the fixture.
    expect(moveToolAction).toHaveBeenCalledWith(
      { id: "t1", sortOrder: 10 },
      { id: "t2", sortOrder: 20 },
    );
  });

  it("does not offer to move the first tool up or the last one down", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    const first = screen.getByText("Zitadel").closest("li");
    // Sentry is the last tool in the whole directory, alone in `monitoring`:
    // no previous, no next.
    const last = screen.getByText("Sentry").closest("li");

    // A control that cannot do anything is worse than no control: it invites a
    // click and answers with nothing.
    expect(within(first as HTMLElement).queryByRole("button", { name: /move up/i })).toBeNull();
    expect(within(last as HTMLElement).queryByRole("button", { name: /move down/i })).toBeNull();
  });

  it("does not offer to move a group's last tool down, even when another group follows", async () => {
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Secret service").closest("li");
    // t2 is last in `identity`, but t3 (ArgoCD, in `delivery`) is next in
    // directory.tools. A neighbour computed from the flat list would offer a
    // "Move down" here and silently move a tool into another group.
    expect(within(row as HTMLElement).queryByRole("button", { name: /move down/i })).toBeNull();
    // And the first tool of the NEXT group must not offer "Move up" for the
    // mirror-image reason.
    const first = screen.getByText("ArgoCD").closest("li");
    expect(within(first as HTMLElement).queryByRole("button", { name: /move up/i })).toBeNull();
  });

  it("offers neither control to the sole tool of a single-tool group", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Sentry").closest("li");
    expect(within(row as HTMLElement).queryByRole("button", { name: /move up/i })).toBeNull();
    expect(within(row as HTMLElement).queryByRole("button", { name: /move down/i })).toBeNull();
  });

  it("shows the write's own refusal when a tool move fails", async () => {
    const user = userEvent.setup();
    vi.mocked(moveToolAction).mockResolvedValue({
      ok: false,
      message: "That change was not saved. Try again shortly.",
    });
    render(<ToolsManager directory={DIRECTORY} />);

    const row = screen.getByText("Zitadel").closest("li");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /move down/i }));

    // The swap is two non-atomic PATCHes; a half-completed move is exactly
    // when the operator needs telling, not silence.
    expect(
      await within(row as HTMLElement).findByText(/not saved\. try again shortly/i),
    ).toBeInTheDocument();
  });

  it("moves a group among its peers", async () => {
    const user = userEvent.setup();
    render(<ToolsManager directory={DIRECTORY} />);

    const section = screen.getByText("Identity and secrets").closest("section");
    await user.click(within(section as HTMLElement).getByRole("button", { name: /move group down/i }));

    expect(moveGroupAction).toHaveBeenCalledWith(
      { key: "identity", sortOrder: 10 },
      { key: "delivery", sortOrder: 20 },
    );
  });

  it("does not offer to move the first group up or the last group down", () => {
    render(<ToolsManager directory={DIRECTORY} />);

    const first = screen.getByText("Identity and secrets").closest("section");
    const last = screen.getByText("Nothing here yet").closest("section");

    expect(
      within(first as HTMLElement).queryByRole("button", { name: /move group up/i }),
    ).toBeNull();
    expect(
      within(last as HTMLElement).queryByRole("button", { name: /move group down/i }),
    ).toBeNull();
  });
});
