import { UsersTable } from "./users-table";
import { KoraAdminError, listKoraUsers, type KoraUserList, type KoraUserSummary } from "@/lib/api/kora-admin";

// Server component, matching the feedback page's server-component + error-
// banner shape (app/admin/apps/kora/feedback/page.tsx). This page exists to
// make Kora's activation drop-off visible: production today is 6 users, 6
// onboarded, 2 who ever logged a meal, and 3 users who made 124 AI calls
// between them producing 3 food logs. Diluting any of the three labelling
// decisions below would erase exactly the cohorts that make that visible.

// LOAD-BEARING. Without this the page is STATICALLY PRERENDERED at build time
// and permanently broken in production — verified, this actually shipped:
// `.next/server/app/admin/apps/kora/users.html` existed in the deployed image
// and every request served it.
//
// The mechanism is worth understanding before anyone "tidies" this away.
// koraAdmin() throws `not_configured` when KORA_API_URL / KORA_BFF_HMAC_KEY
// are unset, and it throws BEFORE it reaches getCurrentSession(). During
// `next build` those env vars are absent, so the page renders its error
// banner and — crucially — never touches cookies, so Next sees no dynamic
// API, classifies the route as static, and bakes that error banner into HTML.
// At runtime the env IS set, but nothing re-renders: every pod serves the
// build-time error forever.
//
// The sibling kora pages escaped this only by accident: feedback, foods and
// audit all read `searchParams`, which forces them dynamic. This page takes
// no params, so nothing made it dynamic. That is luck, not design — any of
// them losing its searchParams would land here too.
//
// force-dynamic, not `revalidate = 0`: this is an authenticated admin surface
// over live data with an irreversible delete one click away. It must never be
// prerendered and must never be cached.
export const dynamic = "force-dynamic";

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
