import { UsersTable } from "./users-table";
import { KoraAdminError, listKoraUsers, type KoraUserList, type KoraUserSummary } from "@/lib/api/kora-admin";

// Server component, matching the feedback page's server-component + error-
// banner shape (app/admin/apps/kora/feedback/page.tsx). This page exists to
// make Kora's activation drop-off visible: production today is 6 users, 6
// onboarded, 2 who ever logged a meal, and 3 users who made 124 AI calls
// between them producing 3 food logs. Diluting any of the three labelling
// decisions below would erase exactly the cohorts that make that visible.

/**
 * The summary strip is built from the API's `summary` tallies, NOT derived
 * by counting `items` client-side — the two can legitimately diverge (the
 * summary is a whole-table aggregate; a future paginated `items` would not
 * be). Percentages are of total users, rounded to whole numbers: with a
 * handful of beta users a decimal implies a precision the sample does not
 * have. Guards `users === 0` explicitly rather than relying on NaN-looks-like-
 * zero, since NaN would render as "NaN%" in the strip.
 */
export function summaryLine(s: KoraUserSummary): string {
  const pct = (n: number) => (s.users === 0 ? 0 : Math.round((n / s.users) * 100));
  return (
    `${s.users} users · ${s.onboarded} onboarded (${pct(s.onboarded)}%) · ` +
    `${s.ever_logged} ever logged (${pct(s.ever_logged)}%) · ` +
    `${s.tried_never_logged} tried but never logged`
  );
}

/**
 * The error banner's body copy. Kept as a pure function (rather than inlined
 * JSX) so it is directly testable from page.test.ts without mounting the
 * component tree — same reasoning as the feedback page's exported `buildHref`.
 */
export function errorMessageFor(status: number, code: string, message?: string): string {
  return `Users could not be loaded. Status ${status} — ${code}${message ? `: ${message}` : ""}`;
}

export default async function KoraUsersPage() {
  let data: KoraUserList | null = null;
  let loadError: KoraAdminError | null = null;

  try {
    data = await listKoraUsers();
  } catch (err) {
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground">
          {data ? summaryLine(data.summary) : "The Kora activation funnel"}
        </p>
      </div>

      {loadError ? (
        // Never render an empty table on error — that reads as "no users",
        // which is a materially different (and much less alarming) fact than
        // "the API is unreachable". The two must be visually distinguishable.
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">{errorMessageFor(loadError.status, loadError.code, loadError.message)}</p>
        </div>
      ) : (
        <UsersTable items={data?.items ?? []} />
      )}
    </div>
  );
}
