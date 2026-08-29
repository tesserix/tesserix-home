// See overview-view.tsx: `StatTile` and `SurfaceStateView` are their own
// `"use client"` components over `@tesserix/web`'s client-only barrel, so a
// server component cannot compose them as JSX. This file carries its own
// directive anyway because it also imports `formatFirstTryRate`, a value
// export of another client component.
"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { StatTile } from "@/components/kit/stat-tile";
import { ResultPager } from "@/components/kit/result-pager";
import { SurfaceStateView } from "@/components/kit/states";
// `import type` only for both of these — see the module doc comment on
// `page.tsx` and `overview-view.tsx`'s identical warning. `entities.ts` and
// `kora-ai-metrics.ts` are both reachable from server-only modules
// (`lib/platform-api.ts` -> `lib/auth/platform-token` -> `pg`), and a client
// component importing a VALUE from either would drag that chain into the
// browser bundle.
import type { SurfaceState } from "@/components/kit/surface-state";
import type { EntityPagination, EntityRecord } from "@/lib/entities";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
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

/** Where an operator goes to find this person — the search box on
 *  `/kora/users` narrows by the same id/label Kora sent, matched or not. A
 *  user this table cannot name is exactly the case an operator most needs
 *  the link for. */
function userHref(userId: string): string {
  return `${USERS_PATH}?q=${encodeURIComponent(userId)}`;
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
    return (
      <Link
        href={userHref(userId)}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {userId}
      </Link>
    );
  }
  return (
    <Link href={userHref(userId)} className="hover:underline">
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

export function AiMetricsView({
  metrics,
  pager,
  pagination,
  state,
  reauthReturnTo,
  userDirectory,
}: AiMetricsViewProps) {
  if (state.kind !== "ready" || !metrics) {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage="Kora has not measured anything yet."
        reauthReturnTo={reauthReturnTo}
      />
    );
  }

  // `Object.entries`, not a fixed list of kind names — see the module doc
  // comment on `kora-ai-metrics.ts`. Every key Kora sent is rendered,
  // including one whose count is zero: dropping it would hide that Kora
  // measured that kind and found none, a different fact from not measuring
  // it at all.
  const byKindEntries = Object.entries(metrics.outcomes.byKind);

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
        {byKindEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kora measured no kinds this window.</p>
        ) : (
          <Table aria-label="Outcomes by kind">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byKindEntries.map(([kind, count]) => (
                <TableRow key={kind}>
                  <TableCell>{kindLabel(kind)}</TableCell>
                  <TableCell className="tabular-nums">{count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Users">
        <h3 className="text-sm font-medium">Users</h3>
        {metrics.users.length === 0 ? (
          // An empty page of users is not a reason to blank the outcomes
          // above it — the read succeeded, this window just has none.
          <p className="text-sm text-muted-foreground">No users in this window.</p>
        ) : (
          <>
            <ResultPager
              label="users"
              count={metrics.users.length}
              total={pagination.total}
              precedingCount={pager.precedingCount}
              nextHref={pager.nextHref}
              previousHref={pager.previousHref}
            />
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
                {metrics.users.map((user) => (
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
                      {/* Optional in the same way `first_try_rate_pct` is:
                          absence is rendered as absence, never as "Never" or
                          an invented instant. */}
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
        )}
      </section>
    </div>
  );
}
