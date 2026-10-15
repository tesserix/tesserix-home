import { describe, expect, it } from "vitest";
import {
  alertTotal,
  changeWarnings,
  isStale,
  parseRepoChangeResults,
  parseRepoListing,
  windowRemaining,
  type Repo,
} from "./repos";

const wireRepo = {
  name: "web",
  url: "https://github.com/tesserix/web",
  description: "",
  visibility: "public",
  archived: false,
  fork: false,
  default_branch: "main",
  language: "TypeScript",
  pushed_at: "2026-10-01T09:00:00Z",
  stars: 2,
  branch_protected: true,
  dependabot_enabled: true,
  dependabot_alerts: { critical: 1, high: 0, medium: 0, low: 3 },
  secret_scanning_alerts: 0,
};

function repo(overrides: Partial<Repo> = {}): Repo {
  return { ...parseRepoListing({ org: "tesserix", repos: [wireRepo], gaps: [] }).repos[0], ...overrides };
}

describe("parseRepoListing", () => {
  it("reads a repository and its signals", () => {
    const listing = parseRepoListing({ org: "tesserix", repos: [wireRepo], gaps: [] });
    expect(listing.repos[0]).toMatchObject({
      name: "web",
      defaultBranch: "main",
      branchProtected: true,
      dependabotAlerts: { critical: 1, high: 0, medium: 0, low: 3 },
      secretScanningAlerts: 0,
    });
  });

  it("keeps an unmeasured signal null rather than zero", () => {
    // A private repository on GitHub Free is not scanned; a zero here would
    // render it as clean.
    const listing = parseRepoListing({
      org: "tesserix",
      repos: [{ ...wireRepo, secret_scanning_alerts: null, dependabot_alerts: null, branch_protected: null }],
      gaps: [],
    });
    expect(listing.repos[0].secretScanningAlerts).toBeNull();
    expect(listing.repos[0].dependabotAlerts).toBeNull();
    expect(listing.repos[0].branchProtected).toBeNull();
    expect(alertTotal(listing.repos[0])).toBeNull();
  });

  it("reads a temporary window and a permanent mark", () => {
    const listing = parseRepoListing({
      org: "tesserix",
      repos: [
        { ...wireRepo, name: "a", public_policy: { kind: "temporary", revert_at: "2026-10-16T00:00:00Z" } },
        { ...wireRepo, name: "b", public_policy: { kind: "permanent", revert_at: null } },
        { ...wireRepo, name: "c", public_policy: null },
      ],
      gaps: [],
    });
    expect(listing.repos.map((r) => r.publicPolicy)).toEqual([
      { kind: "temporary", revertAt: "2026-10-16T00:00:00Z" },
      { kind: "permanent" },
      null,
    ]);
  });

  it("refuses a policy kind it does not know", () => {
    expect(() =>
      parseRepoListing({ org: "tesserix", repos: [{ ...wireRepo, public_policy: { kind: "forever" } }], gaps: [] }),
    ).toThrow(/public_policy.kind/);
  });

  it("refuses a body without gaps rather than claiming none", () => {
    expect(() => parseRepoListing({ org: "tesserix", repos: [] })).toThrow(/gaps/);
  });

  it("refuses a negative or fractional count", () => {
    expect(() =>
      parseRepoListing({ org: "tesserix", repos: [{ ...wireRepo, secret_scanning_alerts: -1 }], gaps: [] }),
    ).toThrow(/secret_scanning_alerts/);
  });
});

describe("parseRepoChangeResults", () => {
  it("reads each repository's outcome", () => {
    expect(
      parseRepoChangeResults({
        results: [
          { name: "a", ok: true, changed: true },
          { name: "b", ok: false, changed: false, error: "refused", message: "GitHub refused: no" },
        ],
      }),
    ).toEqual([
      { name: "a", ok: true, changed: true, message: undefined },
      { name: "b", ok: false, changed: false, message: "GitHub refused: no" },
    ]);
  });
});

describe("changeWarnings", () => {
  it("names the history exposure and each repository's open secrets before publishing", () => {
    const warnings = changeWarnings({ kind: "visibility", visibility: "public", windowHours: 24 }, [
      repo({ name: "leaky", secretScanningAlerts: 2 }),
      repo({ name: "clean", dependabotAlerts: { critical: 0, high: 0, medium: 0, low: 0 } }),
    ]);
    expect(warnings[0]).toMatch(/entire git history/);
    expect(warnings[1]).toMatch(/made private again automatically/);
    expect(warnings).toContain("leaky has 2 open secret-scanning alert(s).");
    expect(warnings.join(" ")).not.toMatch(/clean/);
  });

  it("names lost stars and protection before hiding", () => {
    const warnings = changeWarnings({ kind: "visibility", visibility: "private" }, [repo({ stars: 4 })]);
    expect(warnings[0]).toMatch(/branch protection/);
    expect(warnings).toContain("web will lose its 4 star(s).");
  });

  it("says up front which archived repositories a visibility change will refuse", () => {
    const warnings = changeWarnings({ kind: "visibility", visibility: "private" }, [
      repo({ name: "frozen", archived: true, stars: 0 }),
    ]);
    expect(warnings.at(-1)).toMatch(/frozen/);
  });
});

describe("isStale", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  it("calls a repository with no push stale", () => {
    expect(isStale(repo({ pushedAt: null }), now)).toBe(true);
  });
  it("does not call a recent push stale", () => {
    expect(isStale(repo({ pushedAt: "2026-10-01T00:00:00Z" }), now)).toBe(false);
  });
  it("calls a push older than the threshold stale", () => {
    expect(isStale(repo({ pushedAt: "2025-01-01T00:00:00Z" }), now)).toBe(true);
  });
});

describe("windowRemaining", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  it("counts down in the largest sensible unit", () => {
    expect(windowRemaining("2026-10-15T00:20:00Z", now)).toBe("closes in 20m");
    expect(windowRemaining("2026-10-15T05:00:00Z", now)).toBe("closes in 5h");
    expect(windowRemaining("2026-10-22T00:00:00Z", now)).toBe("closes in 7d");
  });
  it("says closing, not closed, once due — the sweeper has not run yet", () => {
    expect(windowRemaining("2026-10-14T23:59:00Z", now)).toBe("closing");
  });
});
