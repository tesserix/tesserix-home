import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import { costFormatter, tokenFormatter, type AiUsagePoint } from "@/lib/ai-usage";

/**
 * Spend over the window, as columns.
 *
 * Not `@tesserix/web`'s chart components: those are `"use client"`, and this
 * page renders on the server. A column per bucket answers the only question
 * this chart is asked — "when did it move" — without shipping a chart library.
 */

const HOUR = 3600;
const DAY = 86_400;

/**
 * A bucket's axis label, in UTC.
 *
 * UTC because every other timestamp on this surface is the gateway's, and a
 * chart silently in the reader's timezone next to a table in UTC is how an
 * incident gets pinned to the wrong hour.
 */
export function bucketLabel(iso: string, bucketSeconds: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  if (bucketSeconds >= DAY) {
    return at.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  }
  const hours = String(at.getUTCHours()).padStart(2, "0");
  return bucketSeconds >= HOUR ? `${hours}:00` : at.toISOString();
}

export interface UsageTrendProps {
  points: readonly AiUsagePoint[];
  bucketSeconds: number;
  state: SurfaceState;
  emptyMessage: string;
}

export function UsageTrend({ points, bucketSeconds, state, emptyMessage }: UsageTrendProps) {
  const peak = points.reduce((acc, point) => Math.max(acc, point.costUsd), 0);

  return (
    <section className="flex flex-col gap-3" aria-label="Spend over time">
      <div>
        <h3 className="text-sm font-medium">Spend over time</h3>
        <p className="text-xs text-muted-foreground">
          {`Cost per ${bucketSeconds >= DAY ? "day" : `${bucketSeconds / HOUR}h`}, UTC.`}
        </p>
      </div>

      {state.kind !== "ready" ? (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} />
      ) : (
        <ol className="flex h-40 items-end gap-1" role="list">
          {points.map((point) => (
            <li
              key={point.bucket}
              className="flex h-full flex-1 flex-col justify-end"
              // The bar is decorative; the numbers live in the title and the
              // list item's accessible name, so a screen reader gets the same
              // series a sighted reader does.
              title={`${bucketLabel(point.bucket, bucketSeconds)} — ${costFormatter(point.costUsd)}, ${point.requests.toLocaleString()} requests, ${tokenFormatter(point.tokens.input + point.tokens.output)} tokens`}
            >
              <span
                className="block w-full rounded-t bg-primary/70"
                // A zero-cost bucket that still served requests gets a hairline
                // rather than nothing, so a quiet hour is visibly not a gap.
                style={{
                  height:
                    peak === 0
                      ? point.requests > 0
                        ? "2px"
                        : "0"
                      : `${Math.max((point.costUsd / peak) * 100, point.requests > 0 ? 2 : 0)}%`,
                }}
                aria-hidden="true"
              />
              <span className="sr-only">
                {`${bucketLabel(point.bucket, bucketSeconds)}: ${costFormatter(point.costUsd)}`}
              </span>
            </li>
          ))}
        </ol>
      )}

      {state.kind === "ready" && points.length > 0 ? (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{bucketLabel(points[0].bucket, bucketSeconds)}</span>
          <span>{`peak ${costFormatter(peak)}`}</span>
          <span>{bucketLabel(points[points.length - 1].bucket, bucketSeconds)}</span>
        </div>
      ) : null}
    </section>
  );
}
