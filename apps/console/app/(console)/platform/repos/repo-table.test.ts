import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ changeReposAction: vi.fn() }));

import type { Repo } from "@/lib/repos";
import { actionLabel, changeFor, filterRepos, patchFor, resultToast, rowActions, sortFromParams, sortRepos, toolbarActions } from "./repo-table";

function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    name,
    url: `https://github.com/tesserix/${name}`,
    description: "",
    visibility: "private",
    archived: false,
    fork: false,
    defaultBranch: "main",
    language: "",
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

const now = new Date("2026-10-15T00:00:00Z");
const names = (repos: Repo[]) => repos.map((r) => r.name);

describe("filterRepos", () => {
  const repos = [
    repo("clean"),
    repo("hot", { dependabotAlerts: { critical: 0, high: 2, medium: 0, low: 0 } }),
    repo("open", { visibility: "public", branchProtected: false, secretScanningAlerts: 1 }),
    repo("frozen", { archived: true, pushedAt: "2024-01-01T00:00:00Z" }),
    repo("dusty", { pushedAt: "2025-01-01T00:00:00Z" }),
    repo("blind", { dependabotEnabled: false, dependabotAlerts: null }),
  ];

  it("finds critical or high alerts", () => {
    expect(names(filterRepos(repos, { risk: "critical" }, now))).toEqual(["hot"]);
  });

  it("finds public repositories without branch protection", () => {
    expect(names(filterRepos(repos, { risk: "unprotected" }, now))).toEqual(["open"]);
  });

  it("finds repositories nobody is monitoring", () => {
    expect(names(filterRepos(repos, { risk: "unmonitored" }, now))).toEqual(["blind"]);
  });

  it("calls only unarchived repositories stale — archiving is the remedy, not a symptom", () => {
    expect(names(filterRepos(repos, { state: "stale" }, now))).toEqual(["dusty"]);
  });

  it("finds public repositories nobody has decided about", () => {
    const decided = repo("decided", { visibility: "public", publicPolicy: { kind: "permanent" } });
    expect(names(filterRepos([...repos, decided], { risk: "unreviewed" }, now))).toEqual(["open"]);
  });

  it("combines filters", () => {
    expect(names(filterRepos(repos, { visibility: "public", risk: "secrets" }, now))).toEqual(["open"]);
    expect(names(filterRepos(repos, { q: "FRO" }, now))).toEqual(["frozen"]);
  });
});

describe("changeFor", () => {
  it("sends a window or permanence with every publish, never neither", () => {
    expect(changeFor("publish", 24)).toEqual({ kind: "visibility", visibility: "public", windowHours: 24 });
    expect(changeFor("publish", "permanent")).toEqual({ kind: "visibility", visibility: "public", permanent: true });
    expect(changeFor("private", "permanent")).toEqual({ kind: "visibility", visibility: "private" });
  });
});

describe("sortRepos", () => {
  const repos = [
    repo("b-private"),
    repo("a-window", { visibility: "public", publicPolicy: { kind: "temporary", revertAt: "2026-10-16T00:00:00Z" } }),
    repo("c-soon", { visibility: "public", publicPolicy: { kind: "temporary", revertAt: "2026-10-15T01:00:00Z" } }),
    repo("d-open", { visibility: "public" }),
    repo("e-forever", { visibility: "public", publicPolicy: { kind: "permanent" } }),
    repo("f-frozen", { visibility: "public", archived: true }),
  ];

  it("orders visibility the way a review reads it: undecided, windows by closing, permanent, private, archived", () => {
    expect(names(sortRepos(repos, { key: "visibility", dir: "asc" }))).toEqual([
      "d-open",
      "c-soon",
      "a-window",
      "e-forever",
      "b-private",
      "f-frozen",
    ]);
  });

  it("keeps what was not measured last in both directions", () => {
    const measured = [
      repo("none", { secretScanningAlerts: null }),
      repo("two", { secretScanningAlerts: 2 }),
      repo("zero", { secretScanningAlerts: 0 }),
    ];
    expect(names(sortRepos(measured, { key: "secrets", dir: "asc" }))).toEqual(["zero", "two", "none"]);
    expect(names(sortRepos(measured, { key: "secrets", dir: "desc" }))).toEqual(["two", "zero", "none"]);
  });

  it("ranks a critical above any number of lows", () => {
    const alerts = [
      repo("lows", { dependabotAlerts: { critical: 0, high: 0, medium: 0, low: 40 } }),
      repo("one-critical", { dependabotAlerts: { critical: 1, high: 0, medium: 0, low: 0 } }),
    ];
    expect(names(sortRepos(alerts, { key: "alerts", dir: "desc" }))).toEqual(["one-critical", "lows"]);
  });

  it("puts unprotected first ascending, and the Free plan's private repositories with the unmeasured", () => {
    const protection = [
      repo("guarded"),
      repo("bare", { visibility: "public", branchProtected: false }),
      repo("free", { branchProtected: null, branchProtectionUnavailable: true }),
    ];
    expect(names(sortRepos(protection, { key: "protection", dir: "asc" }))).toEqual(["bare", "guarded", "free"]);
  });
});

describe("sortFromParams", () => {
  it("reads a known column and refuses anything else", () => {
    expect(sortFromParams({ sort: "stars", dir: "desc" })).toEqual({ key: "stars", dir: "desc" });
    expect(sortFromParams({ sort: "stars" })).toEqual({ key: "stars", dir: "asc" });
    expect(sortFromParams({ sort: "owner", dir: "desc" })).toEqual({ key: "name", dir: "asc" });
  });
});

describe("toolbarActions", () => {
  const labels = (selected: Repo[]) => toolbarActions(selected).map((a) => `${a.label} → ${a.names.join(",")}`);

  it("offers only what applies to a private selection", () => {
    expect(labels([repo("a"), repo("b")])).toEqual(["Make public… → a,b", "Archive… → a,b"]);
  });

  it("splits a mixed selection, each direction acting on its own part", () => {
    const selected = [repo("a"), repo("b", { visibility: "public" }), repo("c", { archived: true })];
    expect(labels(selected)).toEqual([
      "Make public… (1) → a",
      "Public window… (1) → b",
      "Make private… (1) → b",
      "Archive… (2) → a,b",
      "Unarchive… (1) → c",
    ]);
  });

  it("offers an archived selection only Unarchive, since GitHub refuses the rest", () => {
    expect(labels([repo("a", { archived: true, visibility: "public" })])).toEqual(["Unarchive… → a"]);
  });

  it("marks only a new publish as destructive", () => {
    const actions = toolbarActions([repo("a"), repo("b", { visibility: "public" })]);
    expect(actions.filter((a) => a.destructive).map((a) => a.label)).toEqual(["Make public… (1)"]);
  });
});

describe("rowActions", () => {
  const labels = (r: Repo) => rowActions(r).map((a) => a.label);

  it("fits each state", () => {
    expect(labels(repo("p"))).toEqual(["Make public for…", "Archive…"]);
    expect(labels(repo("w", { visibility: "public", publicPolicy: { kind: "temporary", revertAt: "2026-10-16T00:00:00Z" } }))).toEqual([
      "Extend window…",
      "Mark permanent…",
      "Make private now…",
      "Archive…",
    ]);
    expect(labels(repo("f", { visibility: "public", publicPolicy: { kind: "permanent" } }))).toEqual([
      "Switch to a window…",
      "Make private…",
      "Archive…",
    ]);
    expect(labels(repo("u", { visibility: "public" }))).toEqual([
      "Mark permanent…",
      "Set a window…",
      "Make private…",
      "Archive…",
    ]);
    expect(labels(repo("x", { archived: true }))).toEqual(["Unarchive…"]);
  });

  it("opens Mark permanent on the permanent choice", () => {
    const mark = rowActions(repo("u", { visibility: "public" }))[0];
    expect(mark.preset).toBe("permanent");
  });
});

describe("actionLabel", () => {
  it("names a publish on already-public repositories for what it does", () => {
    const shown = [repo("a", { visibility: "public" })];
    expect(actionLabel("publish", shown, "permanent")).toBe("Mark permanent");
    expect(actionLabel("publish", shown, 24)).toBe("Set window");
    expect(actionLabel("publish", [...shown, repo("b")], 24)).toBe("Make public");
  });
});

describe("patchFor", () => {
  it("shows a window, a mark, a hide and an archive at once", () => {
    const ok = { name: "a", ok: true, changed: true };
    expect(patchFor({ kind: "visibility", visibility: "public", windowHours: 2 }, ok, now)).toEqual({
      visibility: "public",
      publicPolicy: { kind: "temporary", revertAt: "2026-10-15T02:00:00.000Z" },
    });
    expect(patchFor({ kind: "visibility", visibility: "public", permanent: true }, ok, now)).toEqual({
      visibility: "public",
      publicPolicy: { kind: "permanent" },
    });
    expect(patchFor({ kind: "visibility", visibility: "private" }, ok, now)).toEqual({
      visibility: "private",
      publicPolicy: null,
    });
    expect(patchFor({ kind: "archive", archived: true }, { ...ok, archived: true }, now)).toEqual({ archived: true });
  });
});

describe("resultToast", () => {
  it("names the one repository a clean change landed on, and goes away", () => {
    expect(resultToast("Mark permanent", [{ name: "design-system", ok: true, changed: true }])).toEqual({
      variant: "success",
      title: "Mark permanent: design-system",
      description: undefined,
      duration: 5000,
    });
  });

  it("counts a clean batch and says how many were already there", () => {
    const toast = resultToast("Make private", [
      { name: "a", ok: true, changed: true },
      { name: "b", ok: true, changed: true },
      { name: "c", ok: true, changed: false },
    ]);
    expect(toast.title).toBe("Make private: 2 repositories");
    expect(toast.description).toBe("1 already in that state.");
  });

  it("stays until closed when anything failed, so the reasons are not lost", () => {
    const toast = resultToast("Make public", [
      { name: "a", ok: true, changed: true },
      { name: "b", ok: false, changed: false, message: "archived repositories are read-only" },
    ]);
    expect(toast.variant).toBe("warning");
    expect(toast.title).toBe("1 changed, 1 not changed");
    expect(toast.duration).toBe(0);
  });
});
