"use client";

import {
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
import { AlertTriangle, Info } from "lucide-react";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// Type-only. This file is `"use client"`, so a VALUE import here of anything
// that touches `./platform-api` would drag `pg` into the browser bundle —
// `import type` is erased entirely at compile time and carries no such risk.
// See the header of `@/lib/outbox` for why that file is safe to import
// `platform-api` from despite the warning.
import type { EstateOutbox, OutboxEvent, OutboxSourceFailure } from "@/lib/outbox";

/**
 * The client half of the estate outbox — the table, and the two notices that
 * sit above it.
 *
 * A client component for one reason, the same one every sibling surface
 * states: `@tesserix/web`'s barrel is `"use client"`. The page stays a server
 * component so the read happens on the server.
 */

/**
 * How long an event has been waiting, from `age_seconds` — never from
 * `created_at`, and never `0` for an absent value.
 *
 * Absence renders as an em dash. A published row has no `age_seconds` BY
 * DESIGN (it is settled, and a number that grew forever there would read as
 * "stuck" beside a genuinely stuck row) — see `OutboxEvent.ageSeconds`'s own
 * doc comment. Deriving one from `createdAt` here would silently reinstate
 * exactly the number the wire contract omits on purpose.
 */
export function formatAge(ageSeconds: number | undefined): string {
  if (ageSeconds === undefined) return "—";
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The opaque `error` column. Deliberately NOT a switch or lookup table:
 * `outbox_events.error` has no CHECK constraint and the operator requeue path
 * is a raw UPDATE, so a value this build has never seen is expected, not a
 * bug. It is rendered verbatim; only its absence gets a fallback.
 */
export function errorLabel(error: string | undefined): string {
  return error ?? "—";
}

/**
 * The estate is incomplete — one or more products could not be read at all.
 *
 * A genuine failure, and rendered as one: above the table, warning tone, never
 * folded together with `NotImplementedNotice` below. Collapsing the two would
 * tell an operator a product that simply has no events to report right now is
 * BROKEN, which is the opposite of what `domain.Page.NotImplemented` exists to
 * say.
 */
export function IncompleteOutbox({ failures }: { failures: readonly OutboxSourceFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <Callout variant="warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This outbox is incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        {failures.length === 1
          ? "One product could not be read. Its outbox events are missing from the ledger below."
          : `${failures.length} products could not be read. Their outbox events are missing from the ledger below.`}
      </CalloutDescription>
      <ul className="mt-2 space-y-1 text-sm">
        {failures.map((failure) => (
          <li key={failure.source}>
            <span className="font-medium">{failure.source}</span>
            {" — "}
            {failure.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * Products that DECLARED the outbox endpoint but answered 501 for this
 * particular request — a live "nothing to report" statement, not a failure.
 *
 * This is the notice that makes the third response state legible. A genuinely
 * empty, fully-federated outbox and "every configured product said 501 this
 * time" are both a zero-row 200 and would otherwise read identically; this
 * banner is what tells them apart. Calmer tone than `IncompleteOutbox` on
 * purpose — nothing here is broken.
 */
export function NotImplementedNotice({ sources }: { sources: readonly string[] }) {
  if (sources.length === 0) return null;
  return (
    <Callout variant="info" role="status">
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>
          {sources.length === 1
            ? "One product reported no outbox events for this request"
            : `${sources.length} products reported no outbox events for this request`}
        </CalloutTitle>
      </div>
      <CalloutDescription>
        {sources.join(", ")} — nothing is broken; these products simply have nothing to report
        right now.
      </CalloutDescription>
    </Callout>
  );
}

export interface OutboxTableProps {
  outbox: EstateOutbox;
  state: SurfaceState;
  emptyMessage: string;
  reauthReturnTo: string;
}

export function OutboxTable({ outbox, state, emptyMessage, reauthReturnTo }: OutboxTableProps) {
  const { events, failures, notImplemented } = outbox;

  return (
    <div className="flex flex-col gap-4">
      <IncompleteOutbox failures={failures} />
      <NotImplementedNotice sources={notImplemented} />

      {state.kind === "ready" ? (
        <Table aria-label="Estate outbox events">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Event type</TableHead>
              <TableHead>Aggregate</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event: OutboxEvent) => (
              <TableRow key={event.id}>
                <TableCell>{event.source}</TableCell>
                <TableCell>{event.eventType}</TableCell>
                <TableCell>
                  {event.aggregate} #{event.aggregateId}
                </TableCell>
                <TableCell>{event.status}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatAge(event.ageSeconds)}
                </TableCell>
                <TableCell className="font-mono text-xs">{errorLabel(event.error)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} reauthReturnTo={reauthReturnTo} />
      )}
    </div>
  );
}
