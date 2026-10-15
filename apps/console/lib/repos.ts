import { PlatformApiError } from "./platform-api-error";

/**
 * The org's GitHub repositories, as platform-api's `GET /v1/repos` serves them.
 *
 * Every security signal is `null` where it was not measured, and that is a
 * different claim from zero: a private repository on GitHub Free has no secret
 * scanning, and one with Dependabot off has no alerts because nothing is
 * looking. The parser keeps `null` as `null` — defaulting it to 0 would render
 * an unexamined repository as a clean one.
 */

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Repo {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  /** GitHub's word: `public`, `private`, or `internal` on Enterprise. */
  readonly visibility: string;
  readonly archived: boolean;
  readonly fork: boolean;
  readonly defaultBranch: string;
  readonly language: string;
  readonly pushedAt: string | null;
  readonly stars: number;
  readonly branchProtected: boolean | null;
  readonly dependabotEnabled: boolean | null;
  readonly dependabotAlerts: Readonly<Record<Severity, number>> | null;
  readonly secretScanningAlerts: number | null;
  /**
   * Why a public repository is public. `null` on a public one means nobody
   * has decided — the state the window and the permanent mark exist to end.
   * Always `null` on a private one.
   */
  readonly publicPolicy: PublicPolicy | null;
}

export type PublicPolicy =
  | { readonly kind: "permanent" }
  | { readonly kind: "temporary"; readonly revertAt: string };

/** A signal GitHub would not give us for the whole org, and why. */
export interface RepoSignalGap {
  readonly signal: string;
  readonly message: string;
}

export interface RepoListing {
  readonly org: string;
  readonly repos: readonly Repo[];
  readonly gaps: readonly RepoSignalGap[];
}

function fail(message: string): never {
  throw new PlatformApiError(`repos: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} is not an array`);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} is not a boolean`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${path} is not a count`);
  }
  return value;
}

function nullable<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T | null {
  return value === null || value === undefined ? null : read(value, path);
}

function parseAlerts(value: unknown, path: string): Record<Severity, number> {
  const row = record(value, path);
  const out = {} as Record<Severity, number>;
  for (const severity of SEVERITIES) out[severity] = count(row[severity] ?? 0, `${path}.${severity}`);
  return out;
}

function parsePolicy(value: unknown, path: string): PublicPolicy {
  const row = record(value, path);
  const kind = str(row.kind, `${path}.kind`);
  if (kind === "permanent") return { kind };
  if (kind === "temporary") return { kind, revertAt: str(row.revert_at, `${path}.revert_at`) };
  fail(`${path}.kind is not permanent or temporary`);
}

function parseRepo(value: unknown, path: string): Repo {
  const row = record(value, path);
  return {
    name: str(row.name, `${path}.name`),
    url: str(row.url, `${path}.url`),
    description: str(row.description ?? "", `${path}.description`),
    visibility: str(row.visibility, `${path}.visibility`),
    archived: bool(row.archived, `${path}.archived`),
    fork: bool(row.fork, `${path}.fork`),
    defaultBranch: str(row.default_branch ?? "", `${path}.default_branch`),
    language: str(row.language ?? "", `${path}.language`),
    pushedAt: nullable(row.pushed_at, `${path}.pushed_at`, str),
    stars: count(row.stars, `${path}.stars`),
    branchProtected: nullable(row.branch_protected, `${path}.branch_protected`, bool),
    dependabotEnabled: nullable(row.dependabot_enabled, `${path}.dependabot_enabled`, bool),
    dependabotAlerts: nullable(row.dependabot_alerts, `${path}.dependabot_alerts`, parseAlerts),
    secretScanningAlerts: nullable(row.secret_scanning_alerts, `${path}.secret_scanning_alerts`, count),
    publicPolicy: nullable(row.public_policy, `${path}.public_policy`, parsePolicy),
  };
}

export function parseRepoListing(json: unknown): RepoListing {
  const body = record(json, "body");
  return {
    org: str(body.org, "org"),
    repos: array(body.repos, "repos").map((row, i) => parseRepo(row, `repos[${i}]`)),
    // Required, like the tenant directory's `failures`: a body without it
    // cannot say which columns are dashes because GitHub refused, and
    // defaulting it to [] would claim nothing was refused.
    gaps: array(body.gaps, "gaps").map((row, i) => {
      const gap = record(row, `gaps[${i}]`);
      return { signal: str(gap.signal, `gaps[${i}].signal`), message: str(gap.message, `gaps[${i}].message`) };
    }),
  };
}

/** The two changes an operator can make to a selection. */
export type RepoChange =
  | { readonly kind: "visibility"; readonly visibility: "private" }
  /** Public for a window that closes on its own, or permanently. Exactly one —
   *  platform-api refuses a public change that names neither. */
  | { readonly kind: "visibility"; readonly visibility: "public"; readonly windowHours: number }
  | { readonly kind: "visibility"; readonly visibility: "public"; readonly permanent: true }
  | { readonly kind: "archive"; readonly archived: boolean };

/** The windows offered, in hours. platform-api allows 1 to 720; past that a
 *  repository is meant to stay public, and should be marked permanent. */
export const PUBLIC_WINDOWS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
] as const;

/** A public repository nobody has given a window or a permanent mark. */
export function isUnreviewedPublic(repo: Repo): boolean {
  return repo.visibility === "public" && !repo.archived && repo.publicPolicy === null;
}

/** "closes in 3h", "closes in 2d" — or "closing" once due, because the sweeper
 *  runs every minute and a window past its time is not yet a private repo. */
export function windowRemaining(revertAt: string, now: Date = new Date()): string {
  const ms = new Date(revertAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return revertAt;
  if (ms <= 0) return "closing";
  const hours = ms / 3_600_000;
  if (hours < 1) return `closes in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `closes in ${Math.round(hours)}h`;
  return `closes in ${Math.round(hours / 24)}d`;
}

/** What happened to one repository. */
export interface RepoChangeResult {
  readonly name: string;
  readonly ok: boolean;
  /** False for a repository that was already in the requested state. */
  readonly changed: boolean;
  readonly message?: string;
}

export function parseRepoChangeResults(json: unknown): RepoChangeResult[] {
  const body = record(json, "body");
  return array(body.results, "results").map((value, i) => {
    const row = record(value, `results[${i}]`);
    return {
      name: str(row.name, `results[${i}].name`),
      ok: bool(row.ok, `results[${i}].ok`),
      changed: bool(row.changed, `results[${i}].changed`),
      message: typeof row.message === "string" && row.message ? row.message : undefined,
    };
  });
}

/** Total open Dependabot alerts, or null when Dependabot is not measuring. */
export function alertTotal(repo: Repo): number | null {
  if (!repo.dependabotAlerts) return null;
  return SEVERITIES.reduce((sum, severity) => sum + repo.dependabotAlerts![severity], 0);
}

/** Days without a push past which a repository is called stale. */
export const STALE_AFTER_DAYS = 180;

export function isStale(repo: Repo, now: Date = new Date()): boolean {
  if (!repo.pushedAt) return true;
  const pushed = new Date(repo.pushedAt).getTime();
  if (Number.isNaN(pushed)) return false;
  return now.getTime() - pushed > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * What a change will cost each selected repository, said before it is made.
 *
 * Returned per repository rather than as one paragraph, because the costs are
 * per repository: publishing one with open secret-scanning alerts is a
 * different act from publishing one without, and the confirm dialog must show
 * the operator WHICH.
 */
export function changeWarnings(change: RepoChange, repos: readonly Repo[]): string[] {
  const warnings: string[] = [];
  if (change.kind === "visibility" && change.visibility === "public") {
    warnings.push(
      "Making a repository public publishes its entire git history — every file and secret ever committed, including ones since deleted. This cannot be taken back by making it private again.",
    );
    if ("windowHours" in change) {
      warnings.push(
        "It is made private again automatically, within a minute of the window closing. Anything cloned or forked while it was public stays public.",
      );
    }
    for (const repo of repos) {
      if (repo.secretScanningAlerts && repo.secretScanningAlerts > 0) {
        warnings.push(`${repo.name} has ${repo.secretScanningAlerts} open secret-scanning alert(s).`);
      }
      const critical = repo.dependabotAlerts?.critical ?? 0;
      if (critical > 0) warnings.push(`${repo.name} has ${critical} open critical Dependabot alert(s).`);
    }
  }
  if (change.kind === "visibility" && change.visibility === "private") {
    warnings.push(
      "On GitHub Free, a private repository loses its branch protection rules and its GitHub Pages site, and its stars and watchers are removed permanently.",
    );
    for (const repo of repos) {
      if (repo.stars > 0) warnings.push(`${repo.name} will lose its ${repo.stars} star(s).`);
      if (repo.publicPolicy?.kind === "permanent") {
        warnings.push(`${repo.name} is marked permanently public; this removes the mark.`);
      }
    }
  }
  if (change.kind === "archive" && change.archived) {
    warnings.push(
      "An archived repository is read-only: no pushes, issues or pull requests, and Dependabot stops opening alerts for it. It can be unarchived.",
    );
  }
  if (change.kind === "visibility") {
    const archived = repos.filter((repo) => repo.archived).map((repo) => repo.name);
    if (archived.length > 0) {
      warnings.push(`Archived, so they will be refused: ${archived.join(", ")}. Unarchive them first.`);
    }
  }
  return warnings;
}

