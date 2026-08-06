import Link from "next/link";

import { deleteFoodAction, updateFoodAction } from "../actions";
import { DeleteFoodForm, FoodForm } from "../food-form";
import {
  KoraAdminError,
  getKoraFood,
  listKoraEvents,
  type KoraAdminEvent,
  type KoraFoodDetail,
} from "@/lib/api/kora-admin";
import { EventTable } from "../../audit/event-table";

// How much of this food's own history to show inline. The full trail lives on
// /admin/apps/kora/audit; this is the "what happened to THIS row" view.
const HISTORY_LIMIT = 10;

export default async function KoraFoodDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: KoraFoodDetail | null = null;
  let loadError: KoraAdminError | null = null;

  try {
    detail = await getKoraFood(id);
  } catch (err) {
    // Same rule as the index: a failed load must render as a visibly distinct
    // error, never as a blank form. A blank edit form over a real row is worse
    // than an empty table — an operator would fill it in and submit it.
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  // The history is a SEPARATE, non-fatal load: this food's own audit trail is
  // useful context, but failing to fetch it must not take down the edit form.
  let history: KoraAdminEvent[] = [];
  let historyError: KoraAdminError | null = null;
  if (detail) {
    try {
      history = (await listKoraEvents({ targetId: id, limit: HISTORY_LIMIT })).items;
    } catch (err) {
      historyError =
        err instanceof KoraAdminError
          ? err
          : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
    }
  }

  if (loadError || !detail) {
    return (
      <div className="space-y-6 p-6">
        <Link
          href="/admin/apps/kora/foods"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Food index
        </Link>
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">
            {loadError?.status === 404 ? "That food does not exist." : "This food could not be loaded."}
          </p>
          <p className="mt-1">
            Status {loadError?.status} — {loadError?.code}
            {loadError?.message ? `: ${loadError.message}` : ""}
          </p>
        </div>
      </div>
    );
  }

  const { food, log_count: logCount } = detail;

  return (
    <div className="space-y-8 p-6">
      <div>
        <Link
          href="/admin/apps/kora/foods"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Food index
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{food.name}</h1>
        <p className="text-sm text-muted-foreground">
          {food.brand ? `${food.brand} · ` : ""}
          {food.provenance} · last edited {new Date(food.updated_at).toLocaleString()}
          {food.has_embedding ? " · embedded" : " · no embedding"}
        </p>
        {food.deleted_at ? (
          <p
            role="status"
            className="mt-3 inline-block rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            Retired on {new Date(food.deleted_at).toLocaleString()} — hidden from search, the index
            and barcode lookups.
          </p>
        ) : null}
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Edit</h2>
        <FoodForm food={food} action={updateFoodAction} />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Retire</h2>
        <DeleteFoodForm food={food} logCount={logCount} action={deleteFoodAction} />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">History</h2>
        {historyError ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            {/* Distinct from "no history": an empty trail is a claim that
                nobody has ever changed this food, which is not what a failed
                fetch means. */}
            <p className="font-medium">This food&apos;s history could not be loaded.</p>
            <p className="mt-1">
              Status {historyError.status} — {historyError.code}
            </p>
          </div>
        ) : (
          <EventTable events={history} emptyLabel="No admin has changed this food." />
        )}
        <Link
          href={`/admin/apps/kora/audit?target_id=${food.id}`}
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Full audit trail for this food
        </Link>
      </section>
    </div>
  );
}
