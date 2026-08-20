import { SurfaceStateView } from "@/components/kit/states";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import type { SurfaceState } from "@/components/kit/surface-state";
import {
  cacheHitRate,
  costFormatter,
  tokenFormatter,
  type AiUsageBreakdownRow,
} from "@/lib/ai-usage";

/**
 * One breakdown axis as a table.
 *
 * Composed from the shared table primitives rather than `ConsoleDataTable`:
 * that one is `"use client"` and takes paging and sorting callbacks a server
 * component cannot supply, and a breakdown is a whole axis, already ordered by
 * spend, with no page after it.
 */

export interface BreakdownTableProps {
  title: string;
  description?: string;
  rows: readonly AiUsageBreakdownRow[];
  state: SurfaceState;
  emptyMessage: string;
  /** Label for the first column: "Product", "Model", "Capability". */
  axisLabel: string;
}

/** Blank axis value means the gateway could not attribute the request. Kept and
 *  labelled, never dropped: unattributed spend is the spend worth seeing. */
export const UNATTRIBUTED_LABEL = "Unattributed";

export function BreakdownTable({
  title,
  description,
  rows,
  state,
  emptyMessage,
  axisLabel,
}: BreakdownTableProps) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>

      {state.kind !== "ready" ? (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{title}</TableCaption>
            <TableHeader className="bg-muted/50 text-xs uppercase">
              <TableRow>
                <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
                  {axisLabel}
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Requests
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Input
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Output
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Cached
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Refused
                </TableHead>
                <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
                  Cost
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key || UNATTRIBUTED_LABEL} className="border-t">
                  <TableCell className="px-3 py-2">
                    {row.key === "" ? (
                      <span className="italic text-muted-foreground">{UNATTRIBUTED_LABEL}</span>
                    ) : (
                      row.key
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {row.requests.toLocaleString()}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {tokenFormatter(row.tokens.input)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {tokenFormatter(row.tokens.output)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {`${Math.round(cacheHitRate(row.tokens) * 100)}%`}
                  </TableCell>
                  {/* Blocked and errored in one column: both are traffic that
                      bought nothing, and two columns would say the same thing
                      twice. The events tab separates them. */}
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {(row.blocked + row.errors).toLocaleString()}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right font-medium tabular-nums">
                    {costFormatter(row.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
