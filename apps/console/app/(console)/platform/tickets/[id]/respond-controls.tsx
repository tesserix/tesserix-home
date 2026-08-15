"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, CalloutDescription, Textarea } from "@tesserix/web";
import { TICKET_STATUSES, type TicketStatus } from "@/lib/tickets";
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
        onChange={(event) => {
          const next = event.target.value;
          setError(null);
          startTransition(async () => {
            const result: TicketActionResult = await changeTicketStatus(
              ticketId,
              next,
            );
            if (!result.ok) {
              setError(result.message);
            }
            router.refresh();
          });
        }}
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
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await replyToTicket(ticketId, content);
          if (result.ok) {
            setContent("");
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
        <Callout variant="destructive">
          <CalloutDescription>{error}</CalloutDescription>
        </Callout>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || content.trim().length === 0}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
