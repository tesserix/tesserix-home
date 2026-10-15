"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@tesserix/web";
import { AlertTriangle, MoreHorizontal } from "lucide-react";
import { ConsoleDataTable, type Column, type SortSpec } from "@/components/kit/console-data-table";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import { FilterBar, useUrlFilters, type FilterDescriptor, type FilterValues } from "@/components/kit/filter-bar";
import { StatTile } from "@/components/kit/stat-tile";
import { resolveState, type SurfaceError } from "@/components/kit/surface-state";
import {
  alertTotal,
  changeWarnings,
  isStale,
  isUnreviewedPublic,
  PUBLIC_WINDOWS,
  SEVERITIES,
  STALE_AFTER_DAYS,
  type Repo,
  type RepoChange,
  type RepoChangeResult,
  type RepoListing,
  windowRemaining,
} from "@/lib/repos";
import { changeReposAction } from "./actions";

const PAGE_SIZE = 50;

/** How long a row that just changed says so. */
const JUST_CHANGED_MS = 10_000;

export const REPO_FILTERS: FilterDescriptor[] = [
  { key: "q", label: "Search repositories", type: "search" },
  {
    key: "visibility",
    label: "Visibility",
    type: "select",
    options: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
  },
  {
    key: "state",
    label: "State",
    type: "select",
    options: [
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived" },
      { value: "stale", label: `Stale (no push in ${STALE_AFTER_DAYS} days)` },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    type: "select",
    options: [
      { value: "critical", label: "Critical or high alerts" },
      { value: "alerts", label: "Any open alert" },
      { value: "secrets", label: "Secret-scanning alerts" },
      { value: "unreviewed", label: "Public, no window or permanent mark" },
      { value: "unprotected", label: "Public, no branch protection" },
      { value: "unmonitored", label: "Dependabot off" },
    ],
  },
];

/** `?sort=` and `?dir=`, beside the filters, so a link or a refresh keeps the
 *  order. Read through the same hook, so a URL can only carry what is named. */
const SORT_PARAMS: FilterDescriptor[] = [
  { key: "sort", label: "Sort", type: "select" },
  { key: "dir", label: "Direction", type: "select" },
];

const SORT_KEYS = ["name", "visibility", "alerts", "secrets", "protection", "pushed", "language", "stars"] as const;
type SortKey = (typeof SORT_KEYS)[number];

const DEFAULT_SORT: SortSpec = { key: "name", dir: "asc" };

/** The sort a URL asks for, or the default for anything it should not. */
export function sortFromParams(values: FilterValues): SortSpec {
  const key = values.sort;
  if (!key || !(SORT_KEYS as readonly string[]).includes(key)) return DEFAULT_SORT;
  return { key, dir: values.dir === "desc" ? "desc" : "asc" };
}

/** Applies the bar's filters. Exported for the test. */
export function filterRepos(repos: readonly Repo[], values: FilterValues, now = new Date()): Repo[] {
  const q = (values.q ?? "").trim().toLowerCase();
  return repos.filter((repo) => {
    if (q && !repo.name.toLowerCase().includes(q) && !repo.description.toLowerCase().includes(q)) return false;
    if (values.visibility && repo.visibility !== values.visibility) return false;
    if (values.state === "active" && repo.archived) return false;
    if (values.state === "archived" && !repo.archived) return false;
    if (values.state === "stale" && (repo.archived || !isStale(repo, now))) return false;
    switch (values.risk) {
      case "critical":
        return (repo.dependabotAlerts?.critical ?? 0) + (repo.dependabotAlerts?.high ?? 0) > 0;
      case "alerts":
        return (alertTotal(repo) ?? 0) + (repo.secretScanningAlerts ?? 0) > 0;
      case "secrets":
        return (repo.secretScanningAlerts ?? 0) > 0;
      case "unreviewed":
        return isUnreviewedPublic(repo);
      case "unprotected":
        return repo.visibility === "public" && !repo.archived && repo.branchProtected === false;
      case "unmonitored":
        return repo.dependabotEnabled === false;
      default:
        return true;
    }
  });
}

/**
 * What a repository sorts by, compared element by element. `null` is a signal
 * nobody measured, and it sorts LAST whichever way the column runs: flipping
 * to descending must not float the unexamined repositories to the top as if
 * they were the worst — or, ascending, as if they were the cleanest.
 */
function sortValue(repo: Repo, key: SortKey): (string | number)[] | null {
  switch (key) {
    case "name":
      return [repo.name.toLowerCase()];
    case "visibility": {
      // The order a governance pass reads in: public nobody decided about,
      // then windows by how soon they close, then permanent, then private.
      // Archived repositories after all of it — nothing about them can change.
      const policy = repo.publicPolicy;
      const rank =
        repo.visibility !== "public" ? 3 : policy === null ? 0 : policy.kind === "temporary" ? 1 : 2;
      const closes = policy?.kind === "temporary" ? new Date(policy.revertAt).getTime() || 0 : 0;
      return [repo.archived ? 1 : 0, rank, closes];
    }
    case "alerts": {
      const a = repo.dependabotAlerts;
      return a ? [a.critical, a.high, a.medium, a.low] : null;
    }
    case "secrets":
      return repo.secretScanningAlerts === null ? null : [repo.secretScanningAlerts];
    case "protection":
      return repo.branchProtected === null ? null : [repo.branchProtected ? 1 : 0];
    case "pushed":
      return repo.pushedAt ? [repo.pushedAt] : null;
    case "language":
      return repo.language ? [repo.language.toLowerCase()] : null;
    case "stars":
      return [repo.stars];
  }
}

function compareValues(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** Sorts a copy. Ties fall back to the name, so the order is stable. Exported
 *  for the test. */
export function sortRepos(repos: readonly Repo[], sort: SortSpec): Repo[] {
  const key = (SORT_KEYS as readonly string[]).includes(sort.key) ? (sort.key as SortKey) : "name";
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...repos].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else {
      const order = compareValues(va, vb);
      if (order !== 0) return order * dir;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function Absent({ title }: { title: string }) {
  return (
    <span className="text-muted-foreground" title={title}>
      —
    </span>
  );
}

const SEVERITY_VARIANT = { critical: "error", high: "warning", medium: "info", low: "neutral" } as const;

/** Open Dependabot alerts by severity. "Off" and "—" are different claims:
 *  off means nothing is looking, a dash means we could not ask. */
export function AlertsCell({ repo }: { repo: Repo }) {
  if (repo.dependabotEnabled === false) return <Badge variant="outline">Off</Badge>;
  if (!repo.dependabotAlerts) return <Absent title="Not measured" />;
  const open = SEVERITIES.filter((severity) => repo.dependabotAlerts![severity] > 0);
  if (open.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {open.map((severity) => (
        <Badge key={severity} variant={SEVERITY_VARIANT[severity]} title={`${severity} severity`}>
          {repo.dependabotAlerts![severity]} {severity}
        </Badge>
      ))}
    </div>
  );
}

export function ProtectionCell({ repo }: { repo: Repo }) {
  if (repo.branchProtectionUnavailable) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="GitHub Free has no branch protection on private repositories"
      >
        Not on Free
      </span>
    );
  }
  if (repo.branchProtected === null) return <Absent title="Not measured" />;
  if (repo.branchProtected) return <span className="text-muted-foreground">{repo.defaultBranch}</span>;
  return <Badge variant={repo.visibility === "public" ? "warning" : "outline"}>none</Badge>;
}

type Action = "publish" | "private" | "archive" | "unarchive";

/** How long a publish lasts: hours, or for good. */
type PublicChoice = number | "permanent";

/** The change an action makes. Publishing takes the operator's window choice,
 *  which also extends a window or marks an already-public repo permanent. */
export function changeFor(action: Action, choice: PublicChoice): RepoChange {
  switch (action) {
    case "publish":
      return choice === "permanent"
        ? { kind: "visibility", visibility: "public", permanent: true }
        : { kind: "visibility", visibility: "public", windowHours: choice };
    case "private":
      return { kind: "visibility", visibility: "private" };
    case "archive":
      return { kind: "archive", archived: true };
    case "unarchive":
      return { kind: "archive", archived: false };
  }
}

/** The verb for an action on these repositories. A publish on repositories
 *  that are all public already publishes nothing: it sets their window or
 *  their permanent mark, and is named for that. */
export function actionLabel(action: Action, targets: readonly Repo[], choice: PublicChoice): string {
  switch (action) {
    case "publish":
      if (targets.length > 0 && targets.every((repo) => repo.visibility === "public")) {
        return choice === "permanent" ? "Mark permanent" : "Set window";
      }
      return "Make public";
    case "private":
      return "Make private";
    case "archive":
      return "Archive";
    case "unarchive":
      return "Unarchive";
  }
}

/** One button in the selection toolbar: an action and the selected
 *  repositories it applies to. */
export interface ToolbarAction {
  readonly action: Action;
  readonly label: string;
  readonly names: readonly string[];
  /** Newly publishing: the one direction that cannot be taken back. */
  readonly destructive: boolean;
}

/**
 * The actions a selection can take, each with the repositories it applies to.
 *
 * Only actions that apply to something are offered, and a mixed selection
 * gets both directions, each acting on its own part: "Make public (3)" and
 * "Make private (2)" rather than one button that skips half the selection.
 * Archived repositories take only Unarchive — GitHub refuses any other change
 * to one.
 */
export function toolbarActions(selected: readonly Repo[]): ToolbarAction[] {
  const active = selected.filter((repo) => !repo.archived);
  const hidden = active.filter((repo) => repo.visibility !== "public");
  const shown = active.filter((repo) => repo.visibility === "public");
  const archived = selected.filter((repo) => repo.archived);
  const names = (repos: Repo[]) => repos.map((repo) => repo.name);
  const counted = (label: string, n: number) => (n === selected.length ? label : `${label} (${n})`);
  const out: ToolbarAction[] = [];
  const push = (action: Action, label: string, repos: Repo[], destructive = false) =>
    out.push({ action, label: counted(label, repos.length), names: names(repos), destructive });
  if (hidden.length > 0) push("publish", "Make public…", hidden, true);
  if (shown.length > 0) {
    push("publish", "Public window…", shown);
    push("private", "Make private…", shown);
  }
  if (active.length > 0) push("archive", "Archive…", active);
  if (archived.length > 0) push("unarchive", "Unarchive…", archived);
  return out;
}

/** One entry in a row's menu, and the window the dialog opens on. */
export interface RowAction {
  readonly action: Action;
  readonly label: string;
  readonly preset?: PublicChoice;
}

/** What one repository's menu offers: only what fits its state. */
export function rowActions(repo: Repo): RowAction[] {
  if (repo.archived) return [{ action: "unarchive", label: "Unarchive…" }];
  const archive: RowAction = { action: "archive", label: "Archive…" };
  if (repo.visibility !== "public") return [{ action: "publish", label: "Make public for…" }, archive];
  switch (repo.publicPolicy?.kind) {
    case "temporary":
      return [
        { action: "publish", label: "Extend window…", preset: 24 },
        { action: "publish", label: "Mark permanent…", preset: "permanent" },
        { action: "private", label: "Make private now…" },
        archive,
      ];
    case "permanent":
      return [
        { action: "publish", label: "Switch to a window…", preset: PUBLIC_WINDOWS[0].hours },
        { action: "private", label: "Make private…" },
        archive,
      ];
    default:
      return [
        { action: "publish", label: "Mark permanent…", preset: "permanent" },
        { action: "publish", label: "Set a window…", preset: PUBLIC_WINDOWS[0].hours },
        { action: "private", label: "Make private…" },
        archive,
      ];
  }
}

/**
 * What a successful change did to a row, shown at once rather than after the
 * page re-reads. GitHub's own answer wins where the result carries it; the
 * policy is what the change recorded.
 */
export function patchFor(change: RepoChange, result: RepoChangeResult, now: Date = new Date()): Partial<Repo> {
  if (change.kind === "archive") return { archived: result.archived ?? change.archived };
  if (change.visibility === "private") return { visibility: result.visibility ?? "private", publicPolicy: null };
  const publicPolicy =
    "permanent" in change
      ? ({ kind: "permanent" } as const)
      : ({ kind: "temporary", revertAt: new Date(now.getTime() + change.windowHours * 3_600_000).toISOString() } as const);
  return { visibility: result.visibility ?? "public", publicPolicy };
}

function Results({ results, onDismiss }: { results: RepoChangeResult[]; onDismiss: () => void }) {
  const failed = results.filter((result) => !result.ok);
  const changed = results.filter((result) => result.ok && result.changed).length;
  const unchanged = results.filter((result) => result.ok && !result.changed).length;
  return (
    <Callout variant={failed.length > 0 ? "warning" : "success"} role="status">
      <CalloutTitle>
        {changed} changed
        {unchanged > 0 ? `, ${unchanged} already in that state` : ""}
        {failed.length > 0 ? `, ${failed.length} not changed` : ""}
      </CalloutTitle>
      {failed.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {failed.map((result) => (
            <li key={result.name}>
              <span className="font-medium">{result.name}</span> — {result.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="ghost" size="sm" className="mt-2" onClick={onDismiss}>
        Dismiss
      </Button>
    </Callout>
  );
}

/** A visibility badge that, for an operator who can act on it, opens the row's
 *  menu: the next step after seeing "closes in 3h" or "unreviewed" is to
 *  extend, close or mark it. */
function PolicyBadge({
  variant,
  title,
  label,
  onOpen,
}: {
  variant: "info" | "error";
  title: string;
  label: string;
  onOpen?: () => void;
}) {
  const badge = (
    <Badge variant={variant} title={title}>
      {label}
    </Badge>
  );
  if (!onOpen) return badge;
  return (
    <button type="button" className="cursor-pointer rounded-md" aria-label={`${label}: change`} onClick={onOpen}>
      {badge}
    </button>
  );
}

interface Pending {
  readonly action: Action;
  readonly names: readonly string[];
}

export function RepoTable({
  listing,
  error,
  canChange,
}: {
  listing: RepoListing | null;
  error: SurfaceError | null;
  canChange: boolean;
}) {
  const router = useRouter();
  const filters = useUrlFilters(REPO_FILTERS);
  const values = filters.values;
  const sortParams = useUrlFilters(SORT_PARAMS);
  const sort = sortFromParams(sortParams.values);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  // Defaults to the shortest window, never to permanent: the reversible
  // choice is the one a hurried click should land on.
  const [choice, setChoice] = useState<PublicChoice>(PUBLIC_WINDOWS[0].hours);
  const [typed, setTyped] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [results, setResults] = useState<RepoChangeResult[] | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // What a change did, until the page re-reads. A new listing is the truth
  // and replaces them.
  const [patches, setPatches] = useState<Map<string, Partial<Repo>>>(new Map());
  const [justChanged, setJustChanged] = useState<Set<string>>(new Set());
  const [running, startTransition] = useTransition();

  useEffect(() => setPatches(new Map()), [listing]);
  useEffect(() => {
    if (justChanged.size === 0) return;
    const timer = window.setTimeout(() => setJustChanged(new Set()), JUST_CHANGED_MS);
    return () => window.clearTimeout(timer);
  }, [justChanged]);

  const repos = useMemo(
    () => (listing?.repos ?? []).map((repo) => (patches.has(repo.name) ? { ...repo, ...patches.get(repo.name) } : repo)),
    [listing, patches],
  );
  const filtered = useMemo(() => sortRepos(filterRepos(repos, values), sort), [repos, values, sort]);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedRepos = repos.filter((repo) => selected.has(repo.name));
  const targets = pending ? repos.filter((repo) => pending.names.includes(repo.name)) : [];

  const state = resolveState({
    isLoading: false,
    error,
    rows: filtered,
    filtered: Object.values(values).some(Boolean),
  });

  function open(action: Action, names: readonly string[], preset: PublicChoice = PUBLIC_WINDOWS[0].hours) {
    setTyped("");
    setFailure(null);
    setChoice(preset);
    setMenuFor(null);
    setPending({ action, names });
  }

  const change = pending ? changeFor(pending.action, choice) : null;
  const label = pending ? actionLabel(pending.action, targets, choice) : "";
  // Typing the org name is asked only where a repository would newly become
  // public. Extending a window, or marking an already-public one permanent,
  // publishes nothing that is not already published.
  const publishing = pending?.action === "publish" && targets.some((r) => r.visibility !== "public");
  const org = listing?.org ?? "";

  function confirm() {
    if (!change || !pending) return;
    const names = [...pending.names];
    setFailure(null);
    startTransition(async () => {
      const outcome = await changeReposAction(names, change);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setResults(outcome.results);
      const landed = outcome.results.filter((r) => r.ok);
      setPatches((previous) => {
        const next = new Map(previous);
        for (const result of landed) next.set(result.name, { ...next.get(result.name), ...patchFor(change, result) });
        return next;
      });
      setJustChanged(new Set(landed.filter((r) => r.changed).map((r) => r.name)));
      // Drop what landed from the selection and keep the rest, so a retry of
      // the failures is one click and nothing that landed is sent again.
      setSelected((previous) => {
        const next = new Set(previous);
        for (const result of landed) next.delete(result.name);
        return next;
      });
      setPending(null);
      router.refresh();
    });
  }

  const columns = useMemo<Column<Repo>[]>(() => {
    const openMenu = canChange ? (name: string) => () => setMenuFor(name) : undefined;
    const base: Column<Repo>[] = [
      {
        key: "name",
        header: "Repository",
        sortable: true,
        cell: (repo) => (
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              <a href={repo.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                {repo.name}
              </a>
              {repo.fork ? <Badge variant="outline">fork</Badge> : null}
              {justChanged.has(repo.name) ? (
                <Badge variant="success" role="status">
                  updated
                </Badge>
              ) : null}
            </span>
            {repo.description ? (
              <span className="text-muted-foreground max-w-md truncate text-xs">{repo.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: "visibility",
        header: "Visibility",
        sortable: true,
        cell: (repo) => (
          <div className="flex flex-wrap gap-1">
            <Badge variant={repo.visibility === "public" ? "warning" : "secondary"}>{repo.visibility}</Badge>
            {repo.publicPolicy?.kind === "permanent" ? <Badge variant="outline">permanent</Badge> : null}
            {repo.publicPolicy?.kind === "temporary" ? (
              <PolicyBadge
                variant="info"
                title={`Made private again at ${repo.publicPolicy.revertAt}`}
                label={windowRemaining(repo.publicPolicy.revertAt)}
                onOpen={repo.archived ? undefined : openMenu?.(repo.name)}
              />
            ) : null}
            {isUnreviewedPublic(repo) ? (
              <PolicyBadge
                variant="error"
                title="Public with no window and no permanent mark — nobody has decided it should be"
                label="unreviewed"
                onOpen={openMenu?.(repo.name)}
              />
            ) : null}
            {repo.archived ? <Badge variant="outline">archived</Badge> : null}
          </div>
        ),
      },
      { key: "alerts", header: "Dependabot", sortable: true, cell: (repo) => <AlertsCell repo={repo} /> },
      {
        key: "secrets",
        header: "Secrets",
        sortable: true,
        cell: (repo) =>
          repo.secretScanningAlerts === null ? (
            <Absent title="Not scanned — GitHub Free scans public repositories only" />
          ) : repo.secretScanningAlerts > 0 ? (
            <Badge variant="error">{repo.secretScanningAlerts} open</Badge>
          ) : (
            <span className="text-muted-foreground">None</span>
          ),
      },
      { key: "protection", header: "Protection", sortable: true, cell: (repo) => <ProtectionCell repo={repo} /> },
      {
        key: "pushed",
        header: "Last push",
        sortable: true,
        cell: (repo) => (
          <span className={isStale(repo) && !repo.archived ? "text-muted-foreground" : undefined}>
            {formatDate(repo.pushedAt)}
          </span>
        ),
      },
      {
        key: "language",
        header: "Language",
        sortable: true,
        cell: (repo) => repo.language || <Absent title="None detected" />,
      },
      {
        key: "stars",
        header: "Stars",
        sortable: true,
        cell: (repo) => <span className="text-muted-foreground tabular-nums">{repo.stars}</span>,
      },
    ];
    if (!canChange) return base;
    return [
      ...base,
      {
        key: "actions",
        header: "",
        cell: (repo) => {
          const actions = rowActions(repo);
          return (
            <DropdownMenu
              // Not modal: an item opens the confirm dialog, and a modal menu
              // closing underneath a dialog opening leaves the page inert.
              modal={false}
              open={menuFor === repo.name}
              onOpenChange={(isOpen) => setMenuFor(isOpen ? repo.name : null)}
            >
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${repo.name}`}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions.map((item, i) => (
                  <Fragment key={item.label}>
                    {item.action === "archive" && i > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem onSelect={() => open(item.action, [repo.name], item.preset)}>
                      {item.label}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ];
  }, [canChange, justChanged, menuFor]);

  const stats = listing
    ? {
        public: repos.filter((r) => r.visibility === "public" && !r.archived).length,
        unreviewed: repos.filter(isUnreviewedPublic).length,
        critical: repos.reduce((n, r) => n + (r.dependabotAlerts?.critical ?? 0), 0),
        high: repos.reduce((n, r) => n + (r.dependabotAlerts?.high ?? 0), 0),
        unmonitored: repos.filter((r) => r.dependabotEnabled === false && !r.archived).length,
      }
    : null;

  const toolbar = toolbarActions(selectedRepos);

  return (
    <div className="flex flex-col gap-4">
      {stats ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Repositories" value={repos.length} />
          <StatTile label="Public (active)" value={stats.public} />
          <StatTile label="Unreviewed public" value={stats.unreviewed} />
          <StatTile label="Critical alerts" value={stats.critical} />
          <StatTile label="High alerts" value={stats.high} />
          <StatTile label="Dependabot off" value={stats.unmonitored} />
        </div>
      ) : null}

      {listing && listing.gaps.length > 0 ? (
        <Callout variant="warning">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <CalloutTitle>Some signals could not be read</CalloutTitle>
          </div>
          <CalloutDescription>
            Those columns show a dash rather than a count. A dash is not a clean result.
          </CalloutDescription>
          <ul className="mt-2 space-y-1 text-sm">
            {listing.gaps.map((gap) => (
              <li key={gap.signal}>
                <span className="font-medium">{gap.signal.replaceAll("_", " ")}</span> — {gap.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {results ? <Results results={results} onDismiss={() => setResults(null)} /> : null}

      <FilterBar
        descriptors={REPO_FILTERS}
        values={values}
        onChange={(key, value) => {
          filters.set(key, value);
          setPage(1);
        }}
        onClear={() => {
          filters.clear();
          setPage(1);
        }}
      />

      {canChange && selected.size > 0 ? (
        <div
          role="toolbar"
          aria-label="Change selected repositories"
          className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        >
          <span className="text-sm font-medium">{selected.size} selected</span>
          {toolbar.map((option) => (
            <Button
              key={option.label}
              size="sm"
              variant={option.destructive ? "destructive" : "outline"}
              onClick={() => open(option.action, option.names)}
            >
              {option.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <ConsoleDataTable
        label="Repositories"
        columns={columns}
        rows={pageRows}
        rowKey={(repo) => repo.name}
        rowLabel={(repo) => repo.name}
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        sort={sort}
        onSortChange={(next) => {
          sortParams.set("sort", next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir ? "" : next.key);
          sortParams.set("dir", next.dir === "desc" ? "desc" : "");
          setPage(1);
        }}
        state={state}
        emptyMessage="The organisation has no repositories."
        selection={canChange ? { selected, onChange: setSelected } : undefined}
        onClearFilters={() => filters.clear()}
      />

      {pending && change ? (
        <DestructiveConfirmDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen && !running) setPending(null);
          }}
          title={`${label}: ${targets.length === 1 ? targets[0].name : `${targets.length} repositories`}`}
          description={
            targets.length === 1
              ? "The change is recorded in the audit log."
              : "Each repository is changed and recorded in the audit log separately. Some may succeed while others fail."
          }
          confirmLabel={label}
          confirmId="repo-change-confirm"
          statusId="repo-change-status"
          loading={running}
          confirmDisabled={publishing && typed.trim() !== org}
          onConfirm={confirm}
        >
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-sm">
            {targets.length > 1 ? (
              <p className="font-mono text-xs break-words">{targets.map((r) => r.name).join(", ")}</p>
            ) : null}
            <ul className="list-disc space-y-1 pl-5">
              {changeWarnings(change, targets).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            {pending.action === "publish" ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 font-medium">Public for</legend>
                <div className="flex flex-wrap gap-1.5">
                  {[...PUBLIC_WINDOWS.map((w) => ({ value: w.hours as PublicChoice, label: w.label })),
                    { value: "permanent" as PublicChoice, label: "Permanently" }].map((option) => (
                    <Button
                      key={option.label}
                      type="button"
                      size="sm"
                      variant={choice === option.value ? "default" : "outline"}
                      aria-pressed={choice === option.value}
                      onClick={() => setChoice(option.value)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {choice === "permanent"
                    ? "Marked permanently public. It stays public until someone makes it private."
                    : publishing
                      ? "Made private again automatically when the window closes."
                      : "The window restarts from now, and the repository is made private again when it closes."}
                </p>
              </fieldset>
            ) : null}
            {publishing ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="repo-publish-confirm">
                  Type <span className="font-mono">{org}</span> to confirm
                </Label>
                <Input
                  id="repo-publish-confirm"
                  autoComplete="off"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            ) : null}
            {failure ? (
              <p id="repo-change-status" role="alert" className="text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        </DestructiveConfirmDialog>
      ) : null}
    </div>
  );
}
