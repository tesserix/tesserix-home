"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, CalloutDescription, CalloutTitle, Input, Label } from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import { ConsoleDataTable, type Column, type SortSpec } from "@/components/kit/console-data-table";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import { FilterBar, type FilterDescriptor, type FilterValues } from "@/components/kit/filter-bar";
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

/** Weighted so a critical outranks any number of lows when sorting. */
function riskScore(repo: Repo): number {
  const a = repo.dependabotAlerts;
  const secrets = (repo.secretScanningAlerts ?? 0) * 1_000_000;
  if (!a) return secrets - 1;
  return secrets + a.critical * 10_000 + a.high * 100 + a.medium * 10 + a.low;
}

function sortRepos(repos: Repo[], sort: SortSpec): Repo[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const key: (repo: Repo) => string | number =
    sort.key === "alerts" ? riskScore : sort.key === "pushed" ? (r) => r.pushedAt ?? "" : (r) => r.name.toLowerCase();
  return [...repos].sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0));
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

const COLUMNS: Column<Repo>[] = [
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
    cell: (repo) => (
      <div className="flex flex-wrap gap-1">
        <Badge variant={repo.visibility === "public" ? "warning" : "secondary"}>{repo.visibility}</Badge>
        {repo.publicPolicy?.kind === "permanent" ? <Badge variant="outline">permanent</Badge> : null}
        {repo.publicPolicy?.kind === "temporary" ? (
          <Badge variant="info" title={`Made private again at ${repo.publicPolicy.revertAt}`}>
            {windowRemaining(repo.publicPolicy.revertAt)}
          </Badge>
        ) : null}
        {isUnreviewedPublic(repo) ? (
          <Badge variant="error" title="Public with no window and no permanent mark — nobody has decided it should be">
            unreviewed
          </Badge>
        ) : null}
        {repo.archived ? <Badge variant="outline">archived</Badge> : null}
      </div>
    ),
  },
  { key: "alerts", header: "Dependabot", sortable: true, cell: (repo) => <AlertsCell repo={repo} /> },
  {
    key: "secrets",
    header: "Secrets",
    cell: (repo) =>
      repo.secretScanningAlerts === null ? (
        <Absent title="Not scanned — GitHub Free scans public repositories only" />
      ) : repo.secretScanningAlerts > 0 ? (
        <Badge variant="error">{repo.secretScanningAlerts} open</Badge>
      ) : (
        <span className="text-muted-foreground">None</span>
      ),
  },
  {
    key: "protection",
    header: "Protection",
    cell: (repo) =>
      repo.branchProtected === null ? (
        <Absent title="Not measured" />
      ) : repo.branchProtected ? (
        <span className="text-muted-foreground">{repo.defaultBranch}</span>
      ) : (
        <Badge variant={repo.visibility === "public" ? "warning" : "outline"}>none</Badge>
      ),
  },
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
  { key: "language", header: "Language", cell: (repo) => repo.language || <Absent title="None detected" /> },
];

type Action = "publish" | "private" | "archive" | "unarchive";

const ACTIONS: { action: Action; label: string }[] = [
  { action: "publish", label: "Make public…" },
  { action: "private", label: "Make private" },
  { action: "archive", label: "Archive" },
  { action: "unarchive", label: "Unarchive" },
];

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
  const [values, setValues] = useState<FilterValues>({});
  const [sort, setSort] = useState<SortSpec>({ key: "name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ action: Action; label: string } | null>(null);
  // Defaults to the shortest window, never to permanent: the reversible
  // choice is the one a hurried click should land on.
  const [choice, setChoice] = useState<PublicChoice>(PUBLIC_WINDOWS[0].hours);
  const [typed, setTyped] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [results, setResults] = useState<RepoChangeResult[] | null>(null);
  const [running, startTransition] = useTransition();

  const repos = listing?.repos ?? [];
  const filtered = useMemo(() => sortRepos(filterRepos(repos, values), sort), [repos, values, sort]);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedRepos = repos.filter((repo) => selected.has(repo.name));

  const state = resolveState({
    isLoading: false,
    error,
    rows: filtered,
    filtered: Object.values(values).some(Boolean),
  });

  const change = pending ? changeFor(pending.action, choice) : null;
  // Typing the org name is asked only where a repository would newly become
  // public. Extending a window, or marking an already-public one permanent,
  // publishes nothing that is not already published.
  const publishing = pending?.action === "publish" && selectedRepos.some((r) => r.visibility !== "public");
  const org = listing?.org ?? "";

  function confirm() {
    if (!change) return;
    const names = [...selected];
    setFailure(null);
    startTransition(async () => {
      const outcome = await changeReposAction(names, change);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setResults(outcome.results);
      // Keep the ones that failed selected, so a retry is one click and the
      // ones that landed are not sent again.
      setSelected(new Set(outcome.results.filter((r) => !r.ok).map((r) => r.name)));
      setPending(null);
      router.refresh();
    });
  }

  const stats = listing
    ? {
        public: repos.filter((r) => r.visibility === "public" && !r.archived).length,
        unreviewed: repos.filter(isUnreviewedPublic).length,
        critical: repos.reduce((n, r) => n + (r.dependabotAlerts?.critical ?? 0), 0),
        high: repos.reduce((n, r) => n + (r.dependabotAlerts?.high ?? 0), 0),
        secrets: repos.reduce((n, r) => n + (r.secretScanningAlerts ?? 0), 0),
        unmonitored: repos.filter((r) => r.dependabotEnabled === false && !r.archived).length,
      }
    : null;

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
          setValues((previous) => ({ ...previous, [key]: value }));
          setPage(1);
        }}
        onClear={() => {
          setValues({});
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
          {ACTIONS.map((option) => (
            <Button
              key={option.action}
              size="sm"
              variant={option.action === "publish" ? "destructive" : "outline"}
              onClick={() => {
                setTyped("");
                setFailure(null);
                setChoice(PUBLIC_WINDOWS[0].hours);
                setPending(option);
              }}
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
        columns={COLUMNS}
        rows={pageRows}
        rowKey={(repo) => repo.name}
        rowLabel={(repo) => repo.name}
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        sort={sort}
        onSortChange={setSort}
        state={state}
        emptyMessage="The organisation has no repositories."
        selection={canChange ? { selected, onChange: setSelected } : undefined}
        onClearFilters={() => setValues({})}
      />

      {pending && change ? (
        <DestructiveConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open && !running) setPending(null);
          }}
          title={`${pending.label}: ${selected.size} ${selected.size === 1 ? "repository" : "repositories"}`}
          description="Each repository is changed and recorded in the audit log separately. Some may succeed while others fail."
          confirmLabel={pending.label.replace("…", "")}
          confirmId="repo-change-confirm"
          statusId="repo-change-status"
          loading={running}
          confirmDisabled={publishing && typed.trim() !== org}
          onConfirm={confirm}
        >
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-sm">
            <p className="font-mono text-xs break-words">{selectedRepos.map((r) => r.name).join(", ")}</p>
            <ul className="list-disc space-y-1 pl-5">
              {changeWarnings(change, selectedRepos).map((warning) => (
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
                    : "Made private again automatically when the window closes. Already-public repositories get this window too."}
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
