import Link from "next/link";

import { EventTable } from "./event-table";
import { KoraAdminError, listKoraEvents, type KoraAdminEvent } from "@/lib/api/kora-admin";

// Server component, matching the food index: paging is plain links against
// `?offset=`, so the page stays server-rendered, shareable and
// back-button-correct.
const PAGE_SIZE = 50;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Next.js hands back `string | string[]` for a repeated query key — taking the
// value unnarrowed lets `?offset=1&offset=2` stringify to "1,2" via
// Array#toString. Same guard the food index uses.
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildHref(params: { targetId: string; offset: number }): string {
  const qs = new URLSearchParams();
  if (params.targetId) qs.set("target_id", params.targetId);
  if (params.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return `/admin/apps/kora/audit${query ? `?${query}` : ""}`;
}

export default async function KoraAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ target_id?: string | string[]; offset?: string | string[] }>;
}) {
  const sp = await searchParams;
  const targetId = firstParam(sp.target_id) ?? "";
  const parsedOffset = Number.parseInt(firstParam(sp.offset) ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let items: KoraAdminEvent[] = [];
  let total = 0;
  let loadError: KoraAdminError | null = null;

  try {
    const page = await listKoraEvents({
      targetId: targetId || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    items = page.items;
    total = page.total;
  } catch (err) {
    // An audit page that renders a failed fetch as an empty table is claiming
    // "no admin has ever changed anything" — a false statement about the
    // integrity record itself, and the worst possible thing for this
    // particular page to get wrong.
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  // A hand-edited or stale URL can carry an offset past the end — the pager
  // never produces one. Handled as real input, same as the food index.
  const isOutOfRange = !loadError && total > 0 && offset > 0 && items.length === 0;
  const lastValidOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const rangeStart = total === 0 ? 0 : Math.min(offset + 1, total);
  const rangeEnd = total === 0 ? 0 : Math.min(offset + items.length, total);
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < total;
  const prevOffset = isOutOfRange ? lastValidOffset : Math.max(0, offset - PAGE_SIZE);

  const rangeLabel = loadError
    ? "Every admin change to Kora's food data"
    : isOutOfRange
      ? `Offset ${formatCount(offset)} is past the end of the trail (${formatCount(total)} total)`
      : `Showing ${formatCount(rangeStart)}–${formatCount(rangeEnd)} of ${formatCount(total)}`;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Audit trail</h1>
        <p className="text-sm text-muted-foreground">{rangeLabel}</p>
      </div>

      {targetId ? (
        <p className="text-sm text-muted-foreground">
          Filtered to one food.{" "}
          <Link href="/admin/apps/kora/audit" className="underline hover:text-foreground">
            Show every change
          </Link>
        </p>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">The audit trail could not be loaded.</p>
          <p className="mt-1">
            Status {loadError.status} — {loadError.code}
            {loadError.message ? `: ${loadError.message}` : ""}
          </p>
        </div>
      ) : (
        <>
          <EventTable
            events={items}
            emptyLabel={
              isOutOfRange
                ? `That page doesn't exist — the trail has ${formatCount(total)} entries.`
                : targetId
                  ? "No admin has changed this food."
                  : "No admin changes have been recorded yet."
            }
          />

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{rangeLabel}</span>
            <div className="flex gap-2">
              <Link
                href={buildHref({ targetId, offset: prevOffset })}
                aria-disabled={!hasPrev}
                tabIndex={hasPrev ? undefined : -1}
                className={`rounded-md border border-border px-3 py-1.5 ${
                  hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-40"
                }`}
              >
                Previous
              </Link>
              <Link
                href={buildHref({ targetId, offset: offset + PAGE_SIZE })}
                aria-disabled={!hasNext}
                tabIndex={hasNext ? undefined : -1}
                className={`rounded-md border border-border px-3 py-1.5 ${
                  hasNext ? "hover:bg-muted" : "pointer-events-none opacity-40"
                }`}
              >
                Next
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
