import type { TicketDetail, TicketReply } from "@/lib/tickets";

interface TicketThreadProps {
  detail: TicketDetail;
}

function Message({
  author,
  meta,
  when,
  children,
  operator,
}: {
  author: string;
  meta?: string;
  when: string;
  children: string;
  operator: boolean;
}) {
  return (
    <article
      className={`rounded-md border p-4 ${
        operator ? "border-border bg-muted/40" : "border-border"
      }`}
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{author}</span>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
        <time
          dateTime={when}
          className="ml-auto text-xs text-muted-foreground"
        >
          {new Date(when).toLocaleString()}
        </time>
      </header>
      <p className="whitespace-pre-wrap text-sm">{children}</p>
    </article>
  );
}

/**
 * The conversation, oldest first: the ticket's own description opens the
 * thread (it is the customer's first message, not metadata), then each reply
 * attributed to its author. `author_type` decides the label — a platform
 * reply must never read as the customer's words.
 */
export function TicketThread({ detail }: TicketThreadProps) {
  const { ticket, replies } = detail;
  return (
    <div className="flex flex-col gap-3">
      <Message
        author={ticket.submittedByName || ticket.submittedByEmail || "Customer"}
        meta={ticket.submittedByEmail}
        when={ticket.createdAt}
        operator={false}
      >
        {ticket.description}
      </Message>
      {replies.map((reply: TicketReply) => (
        <Message
          key={reply.id}
          author={
            reply.authorName ||
            reply.authorEmail ||
            (reply.authorType === "platform_admin" ? "Operator" : "Customer")
          }
          meta={reply.authorType === "platform_admin" ? "platform" : undefined}
          when={reply.createdAt}
          operator={reply.authorType === "platform_admin"}
        >
          {reply.content}
        </Message>
      ))}
    </div>
  );
}
