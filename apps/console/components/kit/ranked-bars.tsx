import { SurfaceStateView, type SurfaceState } from "./states";

/**
 * A ranked breakdown: label, proportion bar, count, share.
 *
 * This is what the console renders instead of a bar chart.
 *
 * `@tesserix/web@1.8.1` ships a `BarChart` in `dist/components/charts/`, but it
 * is NOT reachable: the barrel does not re-export it (`dist/index.d.ts` has no
 * mention of it) and the package's `exports` map declares only `"."` plus
 * themes, so there is no subpath to import it from either. Do not go looking —
 * making it reachable is a design-system change.
 *
 * It would not be the right primitive here anyway. It is a column chart whose
 * values live only in a `title` attribute and whose labels sit under bars of
 * equal width — unusable for "by tenant", where the labels are store names and
 * the number is the whole point. Adding a real charting library is its own
 * decision, not a side effect of moving a support page, so the breakdown is
 * rendered as rows.
 *
 * Deliberately built from markup and tokens rather than `@tesserix/web`, so it
 * carries no `"use client"` directive and can be rendered by a server
 * component. `SurfaceStateView` is imported as a component, not called, so its
 * own client boundary is fine here.
 */

export interface RankedBarRow {
  /** Stable identity for the row; also the React key. */
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** 0–1 share of the breakdown, rendered as the trailing percentage. */
  readonly share: number;
}

export interface RankedBarsProps {
  title: string;
  description?: string;
  rows: readonly RankedBarRow[];
  emptyMessage: string;
  /** Non-ready states render in place of the rows, same as any other surface. */
  state?: SurfaceState;
  /** Long tails are noise on a dashboard; the rest stay one click away. */
  limit?: number;
}

const DEFAULT_LIMIT = 8;

export function RankedBars({
  title,
  description,
  rows,
  emptyMessage,
  state,
  limit = DEFAULT_LIMIT,
}: RankedBarsProps) {
  // Bars are scaled to the largest row, not to the total: at a 40/30/30 split
  // every bar would otherwise be a third of the width and the ranking would be
  // invisible. The share is stated numerically alongside, so nothing is lost.
  const max = rows.reduce((acc, row) => Math.max(acc, row.count), 0);
  const shown = rows.slice(0, limit);
  const resolved: SurfaceState =
    state && state.kind !== "ready" ? state : rows.length === 0 ? { kind: "empty" } : { kind: "ready" };

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {resolved.kind !== "ready" ? (
        <SurfaceStateView state={resolved} emptyMessage={emptyMessage} />
      ) : (
        <ol className="flex flex-col gap-2">
          {shown.map((row) => (
            <li key={row.key} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 truncate" title={row.label}>
                {row.label}
              </span>
              <span
                className="h-2 min-w-px flex-1 overflow-hidden rounded-full bg-muted"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full bg-primary/80"
                  style={{ width: `${max === 0 ? 0 : (row.count / max) * 100}%` }}
                />
              </span>
              <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                {row.count.toLocaleString()} · {Math.round(row.share * 100)}%
              </span>
            </li>
          ))}
          {rows.length > shown.length ? (
            <li className="text-xs text-muted-foreground">
              {`+${rows.length - shown.length} more`}
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}
