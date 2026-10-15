import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ changeReposAction: vi.fn() }));

import type { Repo } from "@/lib/repos";
import { changeFor, filterRepos } from "./repo-table";

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
