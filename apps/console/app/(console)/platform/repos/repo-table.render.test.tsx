import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const changeReposAction = vi.fn();
vi.mock("./actions", () => ({ changeReposAction: (...args: unknown[]) => changeReposAction(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { Repo, RepoListing } from "@/lib/repos";
import { RepoTable } from "./repo-table";

function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    name,
    url: `https://github.com/tesserix/${name}`,
    description: "",
    visibility: "private",
    archived: false,
    fork: false,
    defaultBranch: "main",
    language: "Go",
    pushedAt: "2026-10-01T00:00:00Z",
    stars: 0,
    branchProtected: true,
    dependabotEnabled: true,
    dependabotAlerts: { critical: 0, high: 0, medium: 0, low: 0 },
    secretScanningAlerts: null,
    publicPolicy: null,
    ...overrides,
  };
}

const listing: RepoListing = {
  org: "tesserix",
  repos: [
    repo("api"),
    repo("site", { visibility: "public", secretScanningAlerts: 0 }),
    repo("docs", { visibility: "public", secretScanningAlerts: 0, publicPolicy: { kind: "permanent" } }),
  ],
  gaps: [],
};

describe("RepoTable", () => {
  it("flags a public repository nobody has decided about, and not one marked permanent", () => {
    render(<RepoTable listing={listing} error={null} canChange={false} />);
    expect(screen.getAllByText("unreviewed")).toHaveLength(1);
    expect(screen.getByText("permanent")).toBeTruthy();
  });

  it("offers no selection to an operator without repo-admin", () => {
    render(<RepoTable listing={listing} error={null} canChange={false} />);
    expect(screen.queryByLabelText("Select api")).toBeNull();
  });

  it("asks for a window and the org name before publishing, and sends the window", async () => {
    changeReposAction.mockResolvedValue({ ok: true, results: [{ name: "api", ok: true, changed: true }] });
    render(<RepoTable listing={listing} error={null} canChange />);

    fireEvent.click(screen.getByLabelText("Select api"));
    fireEvent.click(screen.getByRole("button", { name: "Make public…" }));

    // The reversible choice is the default.
    expect(screen.getByRole("button", { name: "1 hour" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "24 hours" }));

    const confirm = screen.getByRole("button", { name: "Make public" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "tesserix" } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(changeReposAction).toHaveBeenCalledWith(["api"], {
        kind: "visibility",
        visibility: "public",
        windowHours: 24,
      }),
    );
  });

  it("does not ask for the org name to mark an already-public repository permanent", () => {
    render(<RepoTable listing={listing} error={null} canChange />);
    fireEvent.click(screen.getByLabelText("Select site"));
    fireEvent.click(screen.getByRole("button", { name: "Make public…" }));
    fireEvent.click(screen.getByRole("button", { name: "Permanently" }));

    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    expect((screen.getByRole("button", { name: "Make public" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
