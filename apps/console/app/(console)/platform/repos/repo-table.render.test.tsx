import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const changeReposAction = vi.fn();
vi.mock("./actions", () => ({ changeReposAction: (...args: unknown[]) => changeReposAction(...args) }));
// The page keeps its filters and sort in the URL, so the router mock holds a
// query and re-renders on replace, as Next does.
const navigation = vi.hoisted(() => ({ query: "", listeners: new Set<() => void>() }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    navigation.listeners.add(listener);
    return () => navigation.listeners.delete(listener);
  };
  return {
    usePathname: () => "/platform/repos",
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => navigation.query)),
    useRouter: () => ({
      refresh: vi.fn(),
      replace: (url: string) => {
        navigation.query = url.split("?")[1] ?? "";
        navigation.listeners.forEach((listener) => listener());
      },
    }),
  };
});

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
    branchProtectionUnavailable: false,
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
  beforeEach(() => {
    navigation.query = "";
    changeReposAction.mockReset();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Public window…" }));
    fireEvent.click(screen.getByRole("button", { name: "Permanently" }));

    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    expect((screen.getByRole("button", { name: "Mark permanent" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers each direction for its own part of a mixed selection", async () => {
    changeReposAction.mockResolvedValue({ ok: true, results: [{ name: "site", ok: true, changed: true }] });
    render(<RepoTable listing={listing} error={null} canChange />);
    fireEvent.click(screen.getByLabelText("Select api"));
    fireEvent.click(screen.getByLabelText("Select site"));

    const toolbar = screen.getByRole("toolbar");
    expect(within(toolbar).getByRole("button", { name: "Make public… (1)" })).toBeTruthy();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Make private… (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Make private" }));

    await waitFor(() =>
      expect(changeReposAction).toHaveBeenCalledWith(["site"], { kind: "visibility", visibility: "private" }),
    );
  });

  it("changes one repository from its row menu, and shows the change at once", async () => {
    changeReposAction.mockResolvedValue({
      ok: true,
      results: [{ name: "site", ok: true, changed: true, visibility: "public" }],
    });
    render(<RepoTable listing={listing} error={null} canChange />);

    // The unreviewed badge opens the row's menu.
    fireEvent.click(screen.getByRole("button", { name: "unreviewed: change" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark permanent…" }));

    expect(screen.getByRole("button", { name: "Permanently" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Mark permanent" }));

    await waitFor(() =>
      expect(changeReposAction).toHaveBeenCalledWith(["site"], { kind: "visibility", visibility: "public", permanent: true }),
    );
    await waitFor(() => expect(screen.queryByText("unreviewed")).toBeNull());
    expect(screen.getAllByText("permanent")).toHaveLength(2);
    expect(screen.getByText("updated")).toBeTruthy();
    expect(screen.getByText("Mark permanent: site")).toBeTruthy();
  });

  it("says a private repository on GitHub Free has no protection, rather than a dash", () => {
    const free: RepoListing = {
      ...listing,
      repos: [repo("api", { branchProtected: null, branchProtectionUnavailable: true })],
    };
    render(<RepoTable listing={free} error={null} canChange={false} />);
    expect(screen.getByText("Not on Free")).toBeTruthy();
  });

  it("keeps the sort in the URL", () => {
    render(<RepoTable listing={listing} error={null} canChange={false} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Visibility/ }));
    });
    expect(navigation.query).toBe("sort=visibility");
    const rows = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("link")[0].textContent);
    expect(rows).toEqual(["site", "docs", "api"]);
  });
});
