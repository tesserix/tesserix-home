import { everLogged, formatDate, isEmpty } from "./format";
import type { KoraUser } from "@/lib/api/kora-admin";

// Presentational only — no mutation, no "use client" needed. The detail
// panel and delete flow are a later task; this page is read-only.
//
// formatDate/everLogged/isEmpty live in ./format.ts, NOT here, so they are
// directly unit-testable — see format.ts's header comment for why a .tsx
// module can't be reached by this repo's vitest `include` pattern.

function YesNo({ value }: { value: boolean }) {
  return (
    <span className={value ? "text-foreground" : "text-muted-foreground"}>{value ? "Yes" : "No"}</span>
  );
}

function UserRow({ item }: { item: KoraUser }) {
  return (
    <tr className="align-top hover:bg-muted/30">
      <td className="px-4 py-3 text-foreground">{item.email}</td>
      <td className="px-4 py-3 text-foreground">{item.display_name || "—"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(item.created_at)}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(item.onboarded_at)}</td>
      <td className="px-4 py-3">
        <YesNo value={everLogged(item.log_count)} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(item.first_log)}</td>
      <td className="px-4 py-3 text-foreground">{item.log_count}</td>
      {/* AI calls attempted: deliberately counts CALLS, including FAILED ones —
          filtering to successes would erase the "tried and failed" cohort,
          the most actionable row on this page. */}
      <td className="px-4 py-3 text-foreground">{item.ai_calls}</td>
      {/* Last write, never "Last seen"/"Last active": max(last food log, last
          AI call) — the last row WRITTEN. Kora records no session/app-open
          event, so a user who reads their diary daily and logs nothing reads
          as inactive here, and the column is named for what it measures. */}
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(item.last_write)}</td>
      <td className="px-4 py-3">
        <YesNo value={item.has_targets} />
      </td>
      <td className="px-4 py-3 text-muted-foreground">{item.timezone || "—"}</td>
    </tr>
  );
}

export function UsersTable({ items }: { items: KoraUser[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Signed up</th>
              <th className="px-4 py-3">Onboarded</th>
              <th className="px-4 py-3">Ever logged</th>
              <th className="px-4 py-3">First log</th>
              <th className="px-4 py-3">Logs</th>
              <th className="px-4 py-3">AI calls attempted</th>
              <th className="px-4 py-3">Last write</th>
              <th className="px-4 py-3">Targets</th>
              <th className="px-4 py-3">Timezone</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isEmpty(items) ? (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">
                  No users yet.
                </td>
              </tr>
            ) : (
              items.map((item) => <UserRow key={item.id} item={item} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
