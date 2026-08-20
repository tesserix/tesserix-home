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
  costFormatter,
  tokenFormatter,
  type AiOutcome,
  type AiUsageEvent,
} from "@/lib/ai-usage";

/**
 * The newest gateway requests, as the gateway saw them.
 *
 * A capped tail, not a paged list: it exists to answer "what just happened",
 * and anything older is a question for the rollups above it. There is no
 * prompt or completion text here by design — the ledger never stored any.
 */

const OUTCOME_LABELS: Record<AiOutcome, string> = {
  ok: "OK",
  guardrail_blocked: "Blocked",
  rate_limited: "Rate limited",
  provider_error: "Provider error",
  gateway_error: "Gateway error",
};

const OUTCOME_TONES: Record<AiOutcome, string> = {
  ok: "text-muted-foreground",
  guardrail_blocked: "text-destructive",
  rate_limited: "text-destructive",
  provider_error: "text-destructive",
  gateway_error: "text-destructive",
};

export function outcomeLabel(outcome: AiOutcome): string {
  return OUTCOME_LABELS[outcome];
}

/**
 * What a request cost, or an em dash.
 *
 * `unpriced` means no price was found for that model, so the stored zero is an
 * absence rather than a free request. Rendering it as "$0.00" would be a claim
 * the ledger cannot make.
 */
export function eventCostLabel(event: AiUsageEvent): string {
  return event.costSource === "unpriced" ? "—" : costFormatter(event.costUsd);
}

/** UTC, to the second — the same clock the gateway stamped the span with. */
export function eventTimeLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().replace("T", " ").slice(0, 19);
}

export interface EventsTableProps {
  events: readonly AiUsageEvent[];
  state: SurfaceState;
  emptyMessage: string;
}

export function EventsTable({ events, state, emptyMessage }: EventsTableProps) {
  if (state.kind !== "ready") {
    return <SurfaceStateView state={state} emptyMessage={emptyMessage} />;
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableCaption className="sr-only">Recent gateway requests</TableCaption>
        <TableHeader className="bg-muted/50 text-xs uppercase">
          <TableRow>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Time (UTC)
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Product
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Model
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
              Tokens
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
              Cost
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
              Latency
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Outcome
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.spanId} className="border-t align-top">
              <TableCell className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                {eventTimeLabel(event.occurredAt)}
              </TableCell>
              <TableCell className="px-3 py-2">
                <div>{event.product}</div>
                {event.capability ? (
                  <div className="text-xs text-muted-foreground">{event.capability}</div>
                ) : null}
              </TableCell>
              <TableCell className="px-3 py-2">
                <div>{event.responseModel ?? event.requestModel}</div>
                <div className="text-xs text-muted-foreground">{event.provider}</div>
              </TableCell>
              <TableCell className="px-3 py-2 text-right tabular-nums">
                {`${tokenFormatter(event.tokens.input)} / ${tokenFormatter(event.tokens.output)}`}
              </TableCell>
              <TableCell className="px-3 py-2 text-right tabular-nums">{eventCostLabel(event)}</TableCell>
              <TableCell className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {event.latencyMs === null ? "—" : `${event.latencyMs.toLocaleString()} ms`}
              </TableCell>
              <TableCell className="px-3 py-2">
                <span className={OUTCOME_TONES[event.outcome]}>
                  {outcomeLabel(event.outcome)}
                </span>
                {event.guardrailRule ? (
                  <div className="text-xs text-muted-foreground">
                    {`${event.guardrailRule} (${event.guardrailAction ?? "reject"})`}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
