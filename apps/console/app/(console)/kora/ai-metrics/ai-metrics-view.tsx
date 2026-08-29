// See overview-view.tsx: `StatTile` and `SurfaceStateView` are their own
// `"use client"` components over `@tesserix/web`'s client-only barrel, so a
// server component cannot compose them as JSX. This file carries its own
// directive anyway because it also imports `formatFirstTryRate`, a value
// export of another client component.
"use client";

import { Fragment } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { StatTile } from "@/components/kit/stat-tile";
import { ResultPager } from "@/components/kit/result-pager";
import { SurfaceStateView } from "@/components/kit/states";
// A VALUE import, deliberately: `surface-state.ts` (unlike `entities.ts` and
// `kora-ai-metrics.ts` below) carries no import of its own and never reaches
// `lib/auth/platform-token` -> `pg` — see that module's own doc comment. It
// is the pure half of the kit built exactly so both server AND client
// components can call `resolveState` directly.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// `import type` only for both of these — see the module doc comment on
// `page.tsx` and `overview-view.tsx`'s identical warning. `entities.ts` and
// `kora-ai-metrics.ts` are both reachable from server-only modules
// (`lib/platform-api.ts` -> `lib/auth/platform-token` -> `pg`), and a client
// component importing a VALUE from either would drag that chain into the
// browser bundle.
import type { EntityPagination, EntityRecord } from "@/lib/entities";
import type { KoraAiMetrics, KoraAiUser } from "@/lib/kora-ai-metrics";
import type { PagerLinks } from "../entity-page";
// The ONE place `first_try_rate_pct` becomes copy — reused here rather than
// re-derived, per the plan's explicit instruction. Both surfaces share the
// exact same non-negotiable: absent must never render as 0%.
import { formatFirstTryRate } from "../overview-view";

/** `id -> EntityRecord`, one page of kora users — see `page.tsx`'s
 *  `buildUserDirectory`, which is the only place this is built. */
export type UserDirectory = ReadonlyMap<string, EntityRecord>;

// Hardcoded rather than imported from `../users/page`: that module is a
// server component pulling `fetchProductEntities` (a value import reaching
// `lib/auth/platform-token` -> `pg`), and this file must not acquire that
// chain — see the `import type` note above. `users/page.tsx`'s own
// `USER_PATH` is the same literal; keep the two in sync by eye.
const USERS_PATH = "/kora/users";

/**
 * Where an operator goes to find a MATCHED user — kora's `/kora/users`
 * search (`SearchEntities`, kora's `api/internal/platformadmin/entities.go`)
 * matches `display_name`, `email` and `handle` only, never `id`. `label` is
 * one of those fields (kora sends the handle, per `entities.ts`'s own doc
 * comment), so searching by it lands the operator on this person's row.
 *
 * There is deliberately no equivalent for an UNMATCHED row: a query built
 * from the raw id would search a field kora's directory does not match on
 * and return nothing, in exactly the case — no name, only an id — where an
 * operator most needs the link to work. See `userCell`, which sends an
 * unmatched row to the plain, unfiltered directory instead.
 */
function matchedUserHref(label: string): string {
  return `${USERS_PATH}?q=${encodeURIComponent(label)}`;
}

/**
 * The full `/kora/ai-metrics` surface — the destination behind the
 * overview's three AI-resolution tiles. Renders everything the endpoint
 * returns beyond those three headline numbers: the measurement window, every
 * kind Kora scored (zero-filled, all of them shown), and the paginated
 * per-user table.
 */

export interface AiMetricsViewProps {
  /** `null` only when `state.kind !== "ready"` — see `page.tsx`'s `aiMetricsState`. */
  metrics: KoraAiMetrics | null;
  pager: PagerLinks;
  pagination: EntityPagination;
  state: SurfaceState;
  reauthReturnTo: string;
  /** One page of kora users, keyed by id — see `page.tsx`'s
   *  `buildUserDirectory`. Only ids inside that one fetched page can be
   *  named; an id not in this map renders as the raw id, never a
   *  placeholder — see `userCell`. */
  userDirectory: UserDirectory;
}

/**
 * A `by_kind` label for display: Kora's own vocabulary, underscore-to-space
 * swapped for readability and reversible by eye — the same presentation-only
 * transform `inbox-queue.tsx`'s `kindLabel` applies, and for the same reason:
 * this is the PRODUCT's word, not a console-invented one.
 */
function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/**
 * `by_kind` grouped by what an operator does about a kind, not by Kora's
 * declaration order — mirrors `resolveoutcome`'s own doc comment
 * (`docs/resolution-outcomes.md`) almost verbatim:
 *
 *   - **Needs attention** — `no_match`, `below_floor`: index problems. These
 *     are the only two kinds `Kind.NeedsHuman()` returns true for.
 *   - **Succeeded** — `cache`, `alias`, `resolved`, `decomposed`: the attempt
 *     produced an answer. `alias` is a PREVIOUS correction paying off.
 *   - **Degraded** — `weak_match`, `transcript_blank`: real signal, but kora
 *     deliberately does not make either triageable.
 *   - **Blocked** — `budget`, `error`: not resolver quality at all — a budget
 *     limit or a provider fault.
 *
 * `no_match` is ordered ahead of `below_floor` inside its group, because the
 * two are not equally urgent — see `KIND_SEVERITY`.
 */
const KIND_GROUPS: readonly { label: string; kinds: readonly string[] }[] = [
  { label: "Needs attention", kinds: ["no_match", "below_floor"] },
  { label: "Succeeded", kinds: ["cache", "alias", "resolved", "decomposed"] },
  { label: "Degraded", kinds: ["weak_match", "transcript_blank"] },
  { label: "Blocked", kinds: ["budget", "error"] },
];

/** Label for a group of kinds a build has never seen — an unrecognised kind
 *  is a future addition to Kora's vocabulary, not something to drop. Same
 *  "unknown is rendered verbatim, never hidden" rule `inbox-queue.tsx`
 *  applies to `kind` and `severity`. */
const OTHER_GROUP_LABEL = "Other";

export interface KindRow {
  readonly kind: string;
  readonly count: number;
}

export interface KindGroup {
  readonly label: string;
  readonly rows: readonly KindRow[];
}

/**
 * Groups `by_kind` for display. Every key present in `byKind` is rendered
 * exactly once, including a zero count — dropping a zero would hide that
 * Kora measured that kind and found none, a different fact from not
 * measuring it at all (the same rule `firstTryRatePct` follows on this
 * surface). A key this build does not recognise lands in a trailing "Other"
 * group instead of being silently dropped.
 */
export function groupByKind(byKind: Readonly<Record<string, number>>): KindGroup[] {
  const seen = new Set<string>();
  const groups: KindGroup[] = [];
  for (const group of KIND_GROUPS) {
    const rows = group.kinds
      .filter((kind) => kind in byKind)
      .map((kind) => {
        seen.add(kind);
        return { kind, count: byKind[kind] };
      });
    if (rows.length > 0) {
      groups.push({ label: group.label, rows });
    }
  }
  const rest = Object.keys(byKind).filter((kind) => !seen.has(kind));
  if (rest.length > 0) {
    groups.push({ label: OTHER_GROUP_LABEL, rows: rest.map((kind) => ({ kind, count: byKind[kind] })) });
  }
  return groups;
}

/**
 * Where the estate inbox already filters to Kora — `?source=kora` is the
 * param `readSource` (`platform/inbox/page.tsx`) reads.
 *
 * `Kind.NeedsHuman()` (kora's `resolveoutcome/model.go`) returns true for
 * exactly `no_match` and `below_floor` — its own comment explains why the
 * other eight are excluded: "a weak match is a soft signal and a
 * decomposition is a known-imprecise answer, but neither is something an
 * operator can act on; putting them in a triage queue would bury the two
 * that are actionable." The other eight kinds therefore have NO console
 * destination today, and rendering a link for them would ship eight dead
 * ends — the same defect as promising a filtered inbox before the inbox
 * could filter.
 */
const NEEDS_HUMAN_INBOX_HREF = "/platform/inbox?source=kora";

/** kora's own severity for the two triageable kinds — `docs/resolution-
 *  outcomes.md`: "An index gap is `high` severity; a near-miss is `normal`."
 *  A gap has nothing to offer the user at all, while a near-miss at least
 *  returned something they could correct — the two must not read as
 *  equivalent. */
const KIND_SEVERITY: Readonly<Record<string, "high" | "normal">> = {
  no_match: "high",
  below_floor: "normal",
};

// Linkable is expressed as "has a `KIND_SEVERITY` entry" rather than a
// second list, because the two are the SAME two kinds by definition —
// `KIND_SEVERITY`'s keys are exactly `Kind.NeedsHuman()`'s kinds. Keep it
// that way: adding a severity for a kind that is not triageable would
// silently make it linkable too.
function kindHref(kind: string): string | null {
  return kind in KIND_SEVERITY ? NEEDS_HUMAN_INBOX_HREF : null;
}

function kindSeverityTone(kind: string): "destructive" | "warning" | null {
  const severity = KIND_SEVERITY[kind];
  if (severity === "high") return "destructive";
  if (severity === "normal") return "warning";
  return null;
}

/** One row's Kind cell: a link to the kora-filtered inbox for the two
 *  triageable kinds, plain text for the other eight. No tooltip promising a
 *  destination that does not exist for the eight — see `kindHref`. */
function kindCell(kind: string) {
  const href = kindHref(kind);
  const severity = KIND_SEVERITY[kind];
  const tone = kindSeverityTone(kind);
  return (
    <span className="inline-flex items-center gap-2">
      {href ? (
        <Link href={href} className="underline underline-offset-2 hover:text-foreground">
          {kindLabel(kind)}
        </Link>
      ) : (
        kindLabel(kind)
      )}
      {tone ? <Badge variant={tone}>{severity}</Badge> : null}
    </span>
  );
}

/**
 * The per-user filters this surface offers.
 *
 * Only the fields that exist on `KoraAiUser` become activity toggles —
 * `hasCorrections`, `hasBudgetRefusals`, `hasAiCalls`. There is deliberately
 * no "needs human" toggle: that is an aggregate on `outcomes`, computed
 * across every user, not a field any one user row carries.
 *
 * `q` matches the joined name/email AND the raw id (see `matchesUserFilter`)
 * so a UUID pasted from elsewhere still finds its row even when the join
 * could not name it.
 */
export const USER_FILTER_DESCRIPTORS: FilterDescriptor[] = [
  { key: "q", label: "Search this page's users", type: "search" },
  {
    key: "hasCorrections",
    label: "Corrections",
    type: "select",
    options: [{ value: "yes", label: "Has corrections" }],
  },
  {
    key: "hasBudgetRefusals",
    label: "Budget refusals",
    type: "select",
    options: [{ value: "yes", label: "Has budget refusals" }],
  },
  {
    key: "hasAiCalls",
    label: "AI calls",
    type: "select",
    options: [{ value: "yes", label: "Has AI calls" }],
  },
];

/** True when any of `USER_FILTER_DESCRIPTORS` is active. This is the switch
 *  between the true cross-page total (`ResultPager`) and a page-scoped count
 *  — see the "Users" section's render, and the plan's honesty requirement:
 *  a filtered list must never sit beside a total that still counts every
 *  page kora's `ai-metrics` endpoint has no server-side search or filter for. */
export function userFiltersActive(values: FilterValues): boolean {
  return USER_FILTER_DESCRIPTORS.some((descriptor) => (values[descriptor.key] ?? "") !== "");
}

/**
 * Whether one user row matches the active filters.
 *
 * `q` is checked against the raw id AND, where the join found one, the
 * entity's `label`/`sublabel` — kora's contract note (part C's plan) is
 * explicit that a pasted UUID must still find its row even once a name is
 * showing, so the id is never dropped from the haystack just because a name
 * was joined in.
 */
export function matchesUserFilter(
  user: KoraAiUser,
  entity: EntityRecord | undefined,
  values: FilterValues,
): boolean {
  const q = (values.q ?? "").trim().toLowerCase();
  if (q !== "") {
    const haystack = [user.userId, entity?.label, entity?.sublabel].filter(
      (value): value is string => typeof value === "string",
    );
    if (!haystack.some((value) => value.toLowerCase().includes(q))) {
      return false;
    }
  }
  if ((values.hasCorrections ?? "") === "yes" && user.corrections <= 0) return false;
  if ((values.hasBudgetRefusals ?? "") === "yes" && user.budgetRefusals <= 0) return false;
  if ((values.hasAiCalls ?? "") === "yes" && user.aiCalls <= 0) return false;
  return true;
}

/**
 * A user's cell in the table: the joined name where the id was found in
 * `userDirectory`, the raw id where it was not.
 *
 * The raw id is NOT a fallback of last resort dressed up as an error — it is
 * the honest answer when the join can only cover one fetched page of users.
 * "Outside the fetched page" and "does not exist" are different facts, and a
 * placeholder like "Unknown user" would render them identically. Same rule
 * `formatFirstTryRate` and the `lastActivityAt` cell already apply on this
 * surface: absence renders as absence, never as an invented certainty.
 */
function userCell(userId: string, userDirectory: UserDirectory) {
  const entity = userDirectory.get(userId);
  if (!entity) {
    // The plain, unfiltered directory — NOT `?q=<userId>`. kora's search
    // does not match on `id` (see `matchedUserHref`), so a query built from
    // the raw id is a search that structurally cannot find this person.
    // Sending the operator to a filtered result that is guaranteed empty is
    // worse than sending them to the directory honestly unfiltered.
    return (
      <Link
        href={USERS_PATH}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {userId}
      </Link>
    );
  }
  return (
    <Link href={matchedUserHref(entity.label)} className="hover:underline">
      <div>{entity.label}</div>
      {/* Rendered only when present — see `EntityRecord.sublabel`'s doc
          comment. A placeholder here would make "Kora sent no sublabel" look
          like "this user has no handle", which `user-directory.tsx` already
          takes care not to do. */}
      {entity.sublabel ? (
        <div className="text-xs text-muted-foreground">{entity.sublabel}</div>
      ) : null}
    </Link>
  );
}

/**
 * The users table's next/previous links, WITHOUT the range/total text
 * `ResultPager` also renders.
 *
 * Split out because the two halves have different honesty requirements once
 * a filter is active: `pagination.total` counts every page unfiltered, so
 * pairing it with a client-filtered list is the exact "short queue" lie this
 * surface exists to avoid — but the links themselves stay correct even while
 * filtered, because `pageHref` (`entity-page.ts`) preserves every filter
 * param across the page change. Paging while filtered is legitimate; only
 * the total is the part that would lie. See the "Users" section's render.
 */
function UserPagerNav({ pager, label }: { pager: PagerLinks; label: string }) {
  if (!pager.previousHref && !pager.nextHref) return null;
  return (
    <nav aria-label={`${label} pagination`} className="flex items-center gap-2">
      {pager.previousHref ? (
        <Button asChild size="sm" variant="outline">
          <Link href={pager.previousHref} aria-label={`Previous page of ${label}`}>
            Previous
          </Link>
        </Button>
      ) : null}
      {pager.nextHref ? (
        <Button asChild size="sm" variant="outline">
          <Link href={pager.nextHref} aria-label={`Next page of ${label}`}>
            Next
          </Link>
        </Button>
      ) : null}
    </nav>
  );
}

export function AiMetricsView({
  metrics,
  pager,
  pagination,
  state,
  reauthReturnTo,
  userDirectory,
}: AiMetricsViewProps) {
  // Called unconditionally, ahead of the early return below — hooks cannot
  // be conditional, and `metrics` is null exactly when this hook's result
  // goes unused (the early return renders `SurfaceStateView` instead).
  const { values: userFilterValues, set: setUserFilter, clear: clearUserFilters } =
    useUrlFilters(USER_FILTER_DESCRIPTORS);

  if (state.kind !== "ready" || !metrics) {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage="Kora has not measured anything yet."
        reauthReturnTo={reauthReturnTo}
      />
    );
  }

  const byKindGroups = groupByKind(metrics.outcomes.byKind);
  const byKindCount = Object.keys(metrics.outcomes.byKind).length;

  const filtersActive = userFiltersActive(userFilterValues);
  const filteredUsers = metrics.users.filter((user) =>
    matchesUserFilter(user, userDirectory.get(user.userId), userFilterValues),
  );
  // `filtered: filtersActive` is what makes an empty MATCH read as "no
  // results — clear filters" (`filtered-empty`) rather than the plain
  // "nothing here" copy `empty` carries — the distinction `resolveState`
  // exists for. `filteredUsers` can only be empty here when a filter is
  // active: `metrics.users.length === 0` is handled by its own branch below,
  // before this is ever computed.
  const usersSectionState = resolveState({
    isLoading: false,
    error: null,
    rows: filteredUsers,
    filtered: filtersActive,
  });

  return (
    <div className="flex flex-col gap-6">
      {/* The window is a real datum, not chrome — a reader must know what
          period the numbers below it cover. */}
      <p className="text-sm text-muted-foreground">
        Window: <time dateTime={metrics.window.from}>{metrics.window.from}</time>
        {" – "}
        <time dateTime={metrics.window.to}>{metrics.window.to}</time>
      </p>

      <section className="flex flex-col gap-3" aria-label="Outcomes">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Resolution attempts" value={metrics.outcomes.attempts} />
          <StatTile label="Needs human" value={metrics.outcomes.needsHuman} />
          <StatTile
            label="First-try rate"
            value={formatFirstTryRate(metrics.outcomes.firstTryRatePct)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Outcomes by kind">
        <h3 className="text-sm font-medium">By kind</h3>
        {byKindCount === 0 ? (
          <p className="text-sm text-muted-foreground">Kora measured no kinds this window.</p>
        ) : (
          <>
            {/* Only two of the ten kinds have a console destination — see
                `kindHref`. Stated here, not just in a tooltip nobody reads,
                so the other eight rendering unlinked reads as a choice
                rather than an oversight. */}
            <p className="text-xs text-muted-foreground">
              Only &ldquo;no match&rdquo; and &ldquo;below floor&rdquo; link to the inbox — kora
              marks exactly those two as work waiting on a human.
            </p>
            <Table aria-label="Outcomes by kind">
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byKindGroups.map((group) => (
                  <Fragment key={group.label}>
                    <TableRow>
                      <TableCell
                        colSpan={2}
                        className="bg-muted/30 text-xs font-medium uppercase text-muted-foreground"
                      >
                        {group.label}
                      </TableCell>
                    </TableRow>
                    {group.rows.map(({ kind, count }) => (
                      <TableRow key={kind}>
                        <TableCell>{kindCell(kind)}</TableCell>
                        <TableCell className="tabular-nums">{count}</TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Users">
        <h3 className="text-sm font-medium">Users</h3>
        {metrics.users.length === 0 ? (
          // An empty page of users is not a reason to blank the outcomes
          // above it — the read succeeded, this window just has none. No
          // filter can narrow zero rows, so the filter bar has nothing to do
          // here.
          <p className="text-sm text-muted-foreground">No users in this window.</p>
        ) : (
          <>
            <FilterBar
              descriptors={USER_FILTER_DESCRIPTORS}
              values={userFilterValues}
              onChange={setUserFilter}
              onClear={clearUserFilters}
            />
            {/* The page-scoped limitation, stated in the UI rather than left
                for a comment nobody reading the page will see: kora's
                `ai-metrics` endpoint takes only `from`/`to`/`page`/`limit`,
                so these filters can only narrow the page already fetched.
                "Use the pager to reach the rest" lives ONLY in the unfiltered
                branch below — while filtered, the pager is still on screen
                (see `UserPagerNav`), but this sentence is specifically about
                the total the filtered branch deliberately does not show, not
                a claim that paging is unavailable. */}
            <p className="text-xs text-muted-foreground">
              These filters search only the {metrics.users.length} users on this page — kora has
              no server-side search here.
              {filtersActive ? null : " Use the pager to reach the rest."}
            </p>
            {usersSectionState.kind === "ready" ? (
              <>
                {filtersActive ? (
                  // NEVER the cross-page `pagination.total` beside a
                  // filtered list — that total counts every page,
                  // unfiltered, and pairing it with a narrowed list is the
                  // exact defect this surface exists to avoid (see the
                  // plan's "short queue" trap). A page-scoped count instead,
                  // alongside next/prev links that keep working: paging
                  // while filtered is legitimate (`pageHref` carries the
                  // filter query to the next page), and only the total was
                  // the lie.
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p aria-live="polite" className="text-sm text-muted-foreground">
                      {filteredUsers.length} of {metrics.users.length} on this page match these
                      filters.
                    </p>
                    <UserPagerNav pager={pager} label="users" />
                  </div>
                ) : (
                  <ResultPager
                    label="users"
                    count={metrics.users.length}
                    total={pagination.total}
                    precedingCount={pager.precedingCount}
                    nextHref={pager.nextHref}
                    previousHref={pager.previousHref}
                  />
                )}
                <Table aria-label="Kora AI users">
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Resolves</TableHead>
                      <TableHead>Corrections</TableHead>
                      <TableHead>Budget refusals</TableHead>
                      <TableHead>AI calls</TableHead>
                      <TableHead>Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((user) => (
                      <TableRow key={user.userId}>
                        <TableCell className="font-medium">
                          {userCell(user.userId, userDirectory)}
                        </TableCell>
                        <TableCell className="tabular-nums">{user.attempts}</TableCell>
                        <TableCell className="tabular-nums">{user.resolves}</TableCell>
                        <TableCell className="tabular-nums">{user.corrections}</TableCell>
                        <TableCell className="tabular-nums">{user.budgetRefusals}</TableCell>
                        <TableCell className="tabular-nums">{user.aiCalls}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {/* Optional in the same way `first_try_rate_pct`
                              is: absence is rendered as absence, never as
                              "Never" or an invented instant. */}
                          {user.lastActivityAt ? (
                            <time dateTime={user.lastActivityAt}>{user.lastActivityAt}</time>
                          ) : (
                            <span aria-hidden="true">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <SurfaceStateView
                state={usersSectionState}
                emptyMessage="No users match these filters."
                onClearFilters={clearUserFilters}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
