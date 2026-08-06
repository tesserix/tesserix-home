import Link from "next/link";

import { KoraAdminError, listKoraFoods, type KoraFood } from "@/lib/api/kora-admin";

// Kora food index, slice 1: a read-only browse/search over kora_db's
// food_items (~7,900 rows at the time of writing). Server component: the
// search box and pagination are plain GET forms/links against `?q=`/`?offset=`
// so the page stays server-rendered, shareable, and back-button-correct — no
// client-side fetch, no loading spinner to get wrong.
const PAGE_SIZE = 50;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Next.js hands back `string | string[]` for a repeated query key (`?q=a&q=b`
// yields `["a", "b"]`) — typing this narrower than that let `defaultValue`
// (and the value sent upstream via `listKoraFoods`) silently stringify the
// array via `Array#toString` ("a,b"). Always take the first value.
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildHref(params: { q: string; offset: number }): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return `/admin/apps/kora/foods${query ? `?${query}` : ""}`;
}

export default async function KoraFoodsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; offset?: string | string[] }>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q) ?? "";
  const parsedOffset = Number.parseInt(firstParam(sp.offset) ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let items: KoraFood[] = [];
  let total = 0;
  let loadError: KoraAdminError | null = null;

  try {
    const page = await listKoraFoods({ q: q || undefined, limit: PAGE_SIZE, offset });
    items = page.items;
    total = page.total;
  } catch (err) {
    // Kora's bffauth middleware deliberately distinguishes 401 (bad
    // signature/clock/key), 403 (not an admin identity) and 400 (unreadable
    // body) — listKoraFoods preserves that on KoraAdminError. Whatever threw,
    // this MUST render as a visibly distinct error state, never as "no foods
    // found": an error presented as an empty result is a wrong answer
    // presented as a fact, which is the failure mode this project keeps
    // re-learning.
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  // A hand-edited or stale shared URL can carry an offset past the end of
  // the index — the pager itself never produces one, `hasNext` stops that —
  // so this has to be handled as real input, not assumed unreachable.
  // Without it, `rangeStart` (offset + 1) exceeds `total`, producing an
  // inverted "Showing 100,001-7,898 of 7,898" alongside a zero-row table:
  // an empty state rendered over a non-empty index, the exact false fact
  // this slice exists to prevent. Detect it and render an explicit
  // "past the end" state instead of falling into the ordinary empty-results
  // state, and send Previous to the last real page rather than to
  // `offset - PAGE_SIZE`, which would usually still be out of range.
  const isOutOfRange = !loadError && total > 0 && offset > 0 && items.length === 0;
  const lastValidOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const rangeStart = total === 0 ? 0 : Math.min(offset + 1, total);
  const rangeEnd = total === 0 ? 0 : Math.min(offset + items.length, total);
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < total;
  const prevOffset = isOutOfRange ? lastValidOffset : Math.max(0, offset - PAGE_SIZE);
  const rangeLabel = loadError
    ? "Kora's food catalog"
    : isOutOfRange
      ? `Offset ${formatCount(offset)} is past the end of the index (${formatCount(total)} total)`
      : `Showing ${formatCount(rangeStart)}–${formatCount(rangeEnd)} of ${formatCount(total)}`;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Food index</h1>
          <p className="text-sm text-muted-foreground">{rangeLabel}</p>
        </div>
        <Link
          href="/admin/apps/kora/foods/new"
          className="h-9 shrink-0 rounded-md bg-foreground px-4 text-sm font-medium leading-9 text-background hover:bg-foreground/90"
        >
          New food
        </Link>
      </div>

      <form action="/admin/apps/kora/foods" method="get" className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search name or brand…"
          aria-label="Search foods"
          className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm"
        />
        <button
          type="submit"
          className="h-9 rounded-md bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Search
        </button>
        {q ? (
          <Link
            href="/admin/apps/kora/foods"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {loadError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">The food index could not be loaded.</p>
          <p className="mt-1">
            Status {loadError.status} — {loadError.code}
            {loadError.message ? `: ${loadError.message}` : ""}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Brand</th>
                    <th className="px-4 py-3">Provenance</th>
                    <th className="px-4 py-3 text-right">Kcal/100g</th>
                    <th className="px-4 py-3 text-right">Protein</th>
                    <th className="px-4 py-3 text-right">Carbs</th>
                    <th className="px-4 py-3 text-right">Fat</th>
                    <th className="px-4 py-3 text-right">Fiber</th>
                    <th className="px-4 py-3">Serving</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                        {isOutOfRange ? (
                          <>
                            That page doesn&apos;t exist — the index has {formatCount(total)}{" "}
                            items.{" "}
                            <Link
                              href={buildHref({ q, offset: lastValidOffset })}
                              className="text-foreground underline"
                            >
                              Go to the last page
                            </Link>
                          </>
                        ) : q ? (
                          `No foods matched "${q}".`
                        ) : (
                          "No foods found."
                        )}
                      </td>
                    </tr>
                  ) : (
                    items.map((food) => (
                      <tr key={food.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">
                          <Link
                            href={`/admin/apps/kora/foods/${food.id}`}
                            className="underline decoration-transparent hover:decoration-inherit"
                          >
                            {food.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{food.brand || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{food.provenance}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{food.kcal_per_100g}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{food.protein_per_100g}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{food.carbs_per_100g}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{food.fat_per_100g}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{food.fiber_per_100g}</td>
                        <td className="px-4 py-3 text-muted-foreground">{food.serving_desc}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{rangeLabel}</span>
            <div className="flex gap-2">
              <Link
                href={buildHref({ q, offset: prevOffset })}
                aria-disabled={!hasPrev}
                tabIndex={hasPrev ? undefined : -1}
                className={`rounded-md border border-border px-3 py-1.5 ${
                  hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-40"
                }`}
              >
                Previous
              </Link>
              <Link
                href={buildHref({ q, offset: offset + PAGE_SIZE })}
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
