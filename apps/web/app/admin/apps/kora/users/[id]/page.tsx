import Link from "next/link";

import { DeleteUser } from "./delete-user";
import { transferLine } from "./guards";
import { KoraAdminError, getKoraUser, type KoraUserDetail } from "@/lib/api/kora-admin";

// Same reasoning as ../page.tsx, which shipped statically prerendered and
// permanently broken. This route escapes it today only because `[id]` is a
// dynamic segment with no generateStaticParams — i.e. by accident of its
// shape, not by intent. Stated explicitly so it survives a refactor: an
// authenticated admin surface over live data, with an irreversible delete on
// it, must never be prerendered and must never be cached.
export const dynamic = "force-dynamic";

// Server component, matching ../page.tsx's + ../../foods/[id]/page.tsx's
// server-component + error-banner shape. This is the last stop before an
// irreversible, no-grace-period delete, so it exists to answer one question
// before the operator ever sees the delete button: "what does deleting this
// person actually do?" — the counts alone don't answer that, because a count
// says nothing about WHICH other people's groups get reassigned, and to
// whom, or whether an Apple token gets revoked. Deleting a user silently
// reassigns other people's groups; this page shows that first.

/**
 * Per-table counts, sorted by table name for a stable render order (the API
 * returns a map, which has no guaranteed iteration order in the wire
 * format). Kept as a pure function so it's directly testable without
 * mounting the component tree — same reasoning as ../page.tsx's
 * `summaryLine`/`errorMessageFor`.
 */
export function countRows(counts: Record<string, number>): Array<{ table: string; count: number }> {
  return Object.entries(counts)
    .map(([table, count]) => ({ table, count }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

export function loadErrorMessage(status: number, code: string, message?: string): string {
  return `This user could not be loaded. Status ${status} — ${code}${message ? `: ${message}` : ""}`;
}

export default async function KoraUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let user: KoraUserDetail | null = null;
  let loadError: KoraAdminError | null = null;

  try {
    user = await getKoraUser(id);
  } catch (err) {
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  const backLink = (
    <Link href="/admin/apps/kora/users" className="text-sm text-muted-foreground hover:text-foreground">
      ← Users
    </Link>
  );

  // A 404 is visually distinct from both a generic load failure and an
  // empty-but-valid panel: "not found" is a claim about the ID, not about
  // Kora's API being unreachable, and not a claim that this user has no
  // activity.
  if (loadError?.status === 404) {
    return (
      <div className="space-y-6 p-6">
        {backLink}
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">User not found.</p>
          <p className="mt-1">No Kora user exists with this ID.</p>
        </div>
      </div>
    );
  }

  if (loadError || !user) {
    return (
      <div className="space-y-6 p-6">
        {backLink}
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">
            {loadError ? loadErrorMessage(loadError.status, loadError.code, loadError.message) : "This user could not be loaded."}
          </p>
        </div>
      </div>
    );
  }

  const rows = countRows(user.counts);
  const hasTransfers = user.transfers.length > 0;

  return (
    <div className="space-y-8 p-6">
      <div>
        {backLink}
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{user.display_name || user.email}</h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">What this user has</h2>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Table</th>
                <th className="px-4 py-2">Rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                    No owned rows in any table.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.table}>
                    <td className="px-4 py-2 text-foreground">{r.table}</td>
                    <td className="px-4 py-2 text-foreground">{r.count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Ownership transfers on delete</h2>
        {/* A count alone does not say WHO inherits a deleted user's groups —
            this is the consequence an operator must see before confirming,
            not just how many rows would be touched. */}
        {hasTransfers ? (
          <ul className="list-disc space-y-1 rounded-md border border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {user.transfers.map((t) => (
              <li key={`${t.kind}-${t.id}`}>{transferLine(t)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Deleting this user transfers nothing to anyone else.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Apple sign-in</h2>
        <p className="text-sm text-foreground">
          {user.has_apple_token
            ? "This user has an Apple token on file — it will be revoked as part of the delete."
            : "No Apple token on file — nothing to revoke."}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Delete</h2>
        {/* Stated here, in the server-rendered page, not only inside the
            client confirmation control below — this fact must be visible
            the moment the panel loads, not only after the operator has
            already started typing into the confirm field. */}
        <p className="text-sm font-medium text-red-700 dark:text-red-400">
          Deleting a user is irreversible. There is no grace period — once submitted, it cannot be
          undone.
        </p>
        <DeleteUser user={user} />
      </section>
    </div>
  );
}
