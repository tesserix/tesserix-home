// @tesserix/web's barrel is "use client" — see page-header.tsx and every
// sibling table (secrets-table.tsx, inbox-queue.tsx) for the identical note.
"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { Proposal } from "@/lib/secrets";

/**
 * How long ago a proposal was opened, in words.
 *
 * Mirrors `waitedFor` in `platform/inbox/inbox-queue.tsx`: rounded DOWN and
 * never below "just now", so a wait is never overstated to an operator
 * deciding what to look at first. Called the same way that sibling calls
 * `waitedFor` — directly at render with the default `now`, not behind a
 * mount-delay hook; that is this codebase's existing answer to the
 * server/client relative-time question, and this surface has no reason to
 * invent a second one.
 */
export function openedAgo(createdAt: string, now: Date = new Date()): string {
  const opened = new Date(createdAt);
  if (Number.isNaN(opened.getTime())) {
    // An unparseable timestamp is shown as the raw value rather than a
    // confident wrong duration — same choice `waitedFor` makes.
    return createdAt;
  }
  const minutes = Math.floor((now.getTime() - opened.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The detail route's href for one proposal. No route id registers this path
 * — see `packages/console-core/src/routes.ts`'s `platform.secretsReviews`
 * comment: detail routes are not registered in this console.
 */
export function proposalDetailHref(proposal: Pick<Proposal, "number">): string {
  return `/platform/secrets/reviews/${proposal.number}`;
}

export interface ProposalsTableProps {
  proposals: Proposal[];
  state: SurfaceState;
  emptyMessage: string;
  reauthReturnTo: string;
}

/**
 * The client half of the review queue — the table of open proposals.
 *
 * Deliberately renders no approve/merge/reject affordance: those actions
 * require `rotate-credentials` (`secrets-api.ts`'s `approveProposal` /
 * `mergeProposal` / `rejectProposal`), and this list is reachable by
 * `platform` alone. Putting a write control here — even a disabled one that
 * would need its own capability check to hide correctly — would blur the
 * exact line `platform.secretsReviews`'s route-id comment draws: the queue is
 * a read surface, and the authority to act on one entry lives entirely in
 * the detail route a later task builds.
 */
export function ProposalsTable({ proposals, state, emptyMessage, reauthReturnTo }: ProposalsTableProps) {
  if (state.kind !== "ready") {
    return (
      <SurfaceStateView state={state} emptyMessage={emptyMessage} reauthReturnTo={reauthReturnTo} />
    );
  }

  return (
    <Table aria-label="Proposals awaiting review">
      <TableHeader>
        <TableRow>
          <TableHead>Proposal</TableHead>
          <TableHead>Author</TableHead>
          <TableHead>Opened</TableHead>
          <TableHead>GitHub</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {proposals.map((proposal) => (
          <TableRow key={proposal.number}>
            <TableCell>
              <Link
                href={proposalDetailHref(proposal)}
                className="underline underline-offset-2 hover:text-foreground"
              >
                #{proposal.number} {proposal.title}
              </Link>
            </TableCell>
            <TableCell>{proposal.author}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
              {/* `createdAt` is absent when secrets-api could not parse
                  GitHub's timestamp (see `Proposal`'s doc comment in
                  `lib/secrets.ts`) — rendering nothing here is the honest
                  answer; a fabricated "1 Jan year 1" from `new Date(undefined)`
                  would not be. */}
              {proposal.createdAt ? (
                <time dateTime={proposal.createdAt}>{openedAgo(proposal.createdAt)}</time>
              ) : null}
            </TableCell>
            <TableCell>
              <a
                href={proposal.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                View on GitHub
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
