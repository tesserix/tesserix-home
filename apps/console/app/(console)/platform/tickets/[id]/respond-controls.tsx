"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, CalloutDescription, Textarea } from "@tesserix/web";
import { TICKET_STATUSES, isTerminalStatus, type TicketStatus } from "@/lib/tickets";
import {
  changeTicketStatus,
  replyToTicket,
  type TicketActionResult,
} from "./actions";

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

/**
 * The header's status affordance.
 *
 * Terminal tickets get a Reopen button instead of the dropdown — parity with
 * apps/web (`platform-tickets/[id]/page.tsx:287-307`). A resolved ticket has
 * exactly one sensible transition, and offering four in a select makes
 * reopening read like editing a field rather than a decision to take the
 * conversation back up.
 */
export function StatusControl({
  ticketId,
  status,
}: {
  ticketId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const apply = (next: string) => {
    setError(null);
    startTransition(async () => {
      const result: TicketActionResult = await changeTicketStatus(ticketId, next);
      if (!result.ok) {
        setError(result.message);
      }
      router.refresh();
    });
  };

  const errorNode = error ? (
    <span role="alert" className="text-sm text-destructive">
      {error}
    </span>
  ) : null;

  if (isTerminalStatus(status)) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          This ticket is {status.replace("_", " ")}.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => apply("open")}
        >
          {pending ? "Reopening…" : "Reopen"}
        </Button>
        {errorNode}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="ticket-status" className="sr-only">
        Ticket status
      </label>
      <select
        id="ticket-status"
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        value={TICKET_STATUSES.includes(status as TicketStatus) ? status : ""}
        disabled={pending}
        onChange={(event) => apply(event.target.value)}
      >
        {!TICKET_STATUSES.includes(status as TicketStatus) ? (
          <option value="" disabled>
            {status}
          </option>
        ) : null}
        {TICKET_STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_LABELS[value]}
          </option>
        ))}
      </select>
      {errorNode}
    </div>
  );
}

/**
 * The transitions worth offering alongside a reply.
 *
 * Not `TICKET_STATUSES`: "open" is where a ticket already is when it has a
 * composer, and "closed" without a reply-and-close workflow behind it is a
 * trapdoor. Same two apps/web offers (`page.tsx:326-342`).
 */
const STATUS_ON_SEND = ["in_progress", "resolved"] as const satisfies readonly TicketStatus[];

// Radix and plain <select> both need a non-empty value for "no change";
// `NO_TRANSITION` is the sentinel, mapped back to `undefined` on submit so the
// action sends no status at all.
const NO_TRANSITION = "none";

const STATUS_ON_SEND_LABELS: Record<(typeof STATUS_ON_SEND)[number], string> = {
  in_progress: "Mark in progress on send",
  resolved: "Mark resolved on send",
};

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [statusOnSend, setStatusOnSend] = useState<string>(NO_TRANSITION);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await replyToTicket(
            ticketId,
            content,
            statusOnSend === NO_TRANSITION ? undefined : statusOnSend,
          );
          if (result.ok) {
            setContent("");
            setStatusOnSend(NO_TRANSITION);
          } else {
            setError(result.message);
          }
          router.refresh();
        });
      }}
    >
      <label htmlFor="ticket-reply" className="text-sm font-medium">
        Reply
      </label>
      <Textarea
        id="ticket-reply"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={4}
        placeholder="Write a reply to the submitter…"
        disabled={pending}
      />
      {error ? (
        <Callout role="alert" variant="destructive">
          <CalloutDescription>{error}</CalloutDescription>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="ticket-status-on-send" className="sr-only">
          Status on send
        </label>
        <select
          id="ticket-status-on-send"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          value={statusOnSend}
          disabled={pending}
          onChange={(event) => setStatusOnSend(event.target.value)}
        >
          <option value={NO_TRANSITION}>Just send</option>
          {STATUS_ON_SEND.map((value) => (
            <option key={value} value={value}>
              {STATUS_ON_SEND_LABELS[value]}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={pending || content.trim().length === 0}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
