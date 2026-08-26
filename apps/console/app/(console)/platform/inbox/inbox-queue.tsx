"use client";

import {
  Badge,
  Callout,
  CalloutDescription,
  CalloutTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// The estate's product-name lookup, reused rather than re-implemented: it
// renders an id it does not recognise VERBATIM instead of inventing a name,
// which is the property this surface needs. A product implementing §3.2 before
// the console's build knows its id must appear under its raw id, not "Unknown".
import { sourceLabel } from "@/lib/audit";
import type { EstateInbox, InboxItem, InboxSourceFailure } from "@/lib/inbox";

/**
 * The client half of the estate inbox.
 *
 * A client component for one reason: `@tesserix/web`'s barrel is `"use
 * client"`. The page stays a server component so the read happens on the
 * server — the same split as the tenant directory and the audit timeline.
 */

/**
 * How a `kind` is rendered when this build has never seen it.
 *
 * Verbatim, deliberately. `kind` is the PRODUCT's vocabulary — kora emits
 * `feedback` and `unresolved_food` — and a console-side enumeration would be a
 * second vocabulary that drifts from the first. Showing an unknown kind as
 * itself is honest; showing it as "Other" is a small lie that hides a product
 * shipping something new.
 *
 * The underscore-to-space swap is presentation only and reversible by eye:
 * `unresolved_food` reads as "unresolved food" and still says exactly what the
 * product said.
 */
export function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/**
 * How long something has been waiting, in words.
 *
 * Rounded DOWN and never below "just now": an item that has waited 59 minutes
 * is "59m", not "1h". Overstating a wait makes a queue look worse than it is,
 * and this number is the one an operator triages on.
 */
export function waitedFor(waitingSince: string, now: Date = new Date()): string {
  const started = new Date(waitingSince);
  if (Number.isNaN(started.getTime())) {
    // An unparseable timestamp is rendered as the raw value rather than as
    // "just now": inventing a duration from a value we could not read would
    // put a confident wrong number in front of an operator.
    return waitingSince;
  }
  const minutes = Math.floor((now.getTime() - started.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Severity to a badge tone.
 *
 * `neutral` for anything this build does not recognise, which matters more
 * here than it looks: severity is the product's vocabulary like `kind` is, and
 * mapping an unknown word onto a LOUD tone would let a product's new
 * low-priority category arrive painted as an emergency. Unknown means unstyled,
 * never alarming.
 *
 * Returns `@tesserix/web`'s own Badge variants — `destructive`, not `danger`.
 * The union is checked at compile time, which is how the first draft's
 * invented tone was caught.
 */
export function severityTone(
  severity: string | undefined,
): "warning" | "destructive" | "neutral" {
  if (severity === "critical" || severity === "danger") return "destructive";
  if (severity === "warning") return "warning";
  return "neutral";
}

/**
 * The estate is incomplete — one or more products could not be read.
 *
 * Rendered ABOVE the queue rather than below it, and never instead of it. On
 * this surface the stakes are specific: an operator reading a short queue
 * concludes the work is nearly done. A product silently dropping out of the
 * fan-out turns that into a false all-clear, which is the one failure a queue
 * must not have.
 */
export function IncompleteQueue({ failures }: { failures: readonly InboxSourceFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <Callout variant="warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This queue is incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        {failures.length === 1
          ? "One product could not be read. Anything waiting in it is missing from the queue below, and the total understates the estate's backlog."
          : `${failures.length} products could not be read. Anything waiting in them is missing from the queue below, and the total understates the estate's backlog.`}
      </CalloutDescription>
      <ul className="mt-2 space-y-1 text-sm">
        {failures.map((failure) => (
          <li key={failure.source}>
            <span className="font-medium">{sourceLabel(failure.source)}</span>
            {" — "}
            {failure.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export interface InboxQueueProps {
  inbox: EstateInbox;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  reauthReturnTo: string;
}

export function InboxQueue({
  inbox,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: InboxQueueProps) {
  const { items, total, failures } = inbox;

  return (
    <div className="flex flex-col gap-4">
      <IncompleteQueue failures={failures} />

      {state.kind === "ready" ? (
        <>
          <Table aria-label="Waiting on a human">
            <TableHeader>
              <TableRow>
                <TableHead>Waiting</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Product</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item: InboxItem) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <time dateTime={item.waitingSince}>{waitedFor(item.waitingSince)}</time>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{item.title}</div>
                    {item.subtitle ? (
                      <div className="text-xs text-muted-foreground">{item.subtitle}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={severityTone(item.severity)}>{kindLabel(item.kind)}</Badge>
                  </TableCell>
                  <TableCell>{sourceLabel(item.source)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            {/* The estate's queue DEPTH, which may exceed the rows shown. Said
                plainly rather than left for someone to infer from a row count
                that stops at the page bound. */}
            {total === items.length
              ? `${total} waiting.`
              : `Showing ${items.length} of ${total} waiting.`}{" "}
            {scopeNote}
          </p>
        </>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} reauthReturnTo={reauthReturnTo} />
      )}
    </div>
  );
}
