"use client";

import { use, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useToast } from "@tesserix/web";
import { ChevronLeft, Loader2 } from "lucide-react";

interface Ticket {
  id: string;
  product_id: string;
  tenant_id: string;
  ticket_number: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  submitted_by_name: string;
  submitted_by_email: string;
  submitted_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Reply {
  id: string;
  ticket_id: string;
  author_type: "merchant" | "platform_admin";
  author_name: string;
  author_email: string | null;
  author_user_id: string | null;
  content: string;
  created_at: string;
}

interface DetailResponse {
  ticket: Ticket;
  replies: Reply[];
}

const STATUS_TONE: Record<string, string> = {
  open: "text-foreground border-border",
  in_progress: "text-blue-700 border-blue-300 bg-blue-50",
  resolved: "text-emerald-700 border-emerald-300 bg-emerald-50",
  closed: "text-muted-foreground border-border bg-muted",
};

const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground border-border",
  medium: "text-foreground border-border",
  high: "text-amber-700 border-amber-300 bg-amber-50",
  urgent: "text-rose-700 border-rose-300 bg-rose-50 font-semibold",
};

const PRODUCT_TONE: Record<string, string> = {
  mark8ly: "bg-emerald-50 text-emerald-700",
  homechef: "bg-amber-50 text-amber-700",
  fanzone: "bg-violet-50 text-violet-700",
};

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

type StatusOnSend = "none" | "in_progress" | "resolved";

export default function PlatformTicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, error, isLoading, mutate } = useSWR<DetailResponse>(
    `/api/admin/platform-tickets/${id}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [statusOnSend, setStatusOnSend] = useState<StatusOnSend>("none");
  const [submitting, setSubmitting] = useState(false);
  const [reopening, setReopening] = useState(false);

  if (error) {
    return (
      <div className="p-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          Could not load this ticket.
        </div>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="p-6">
        <BackLink />
        <div className="mt-6 space-y-4">
          <div className="h-6 w-48 animate-pulse rounded bg-muted" />
          <div className="h-24 w-full animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const { ticket, replies } = data;
  const terminal = ticket.status === "resolved" || ticket.status === "closed";

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    try {
      const newStatus =
        statusOnSend === "none" ? undefined : statusOnSend;
      const res = await fetch(`/api/admin/platform-tickets/${id}/replies`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim(), newStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({
        title: "Reply sent",
        description: newStatus
          ? `Status updated to ${newStatus.replace("_", " ")}.`
          : undefined,
      });
      setContent("");
      setStatusOnSend("none");
      await mutate();
    } catch {
      toast({ title: "Failed to send reply", description: "Try again." });
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(status: string) {
    setReopening(true);
    try {
      const res = await fetch(`/api/admin/platform-tickets/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: `Ticket ${status.replace("_", " ")}` });
      await mutate();
    } catch {
      toast({ title: "Could not update status", description: "Try again." });
    } finally {
      setReopening(false);
    }
  }

  return (
    <main className="flex h-full flex-col" aria-label={`Ticket ${ticket.ticket_number}`}>
      <div className="border-b border-border px-6 py-4">
        <BackLink />
      </div>
      <div className="flex-1 space-y-8 p-6">
        <header className="space-y-3">
          <p className="font-mono text-xs text-muted-foreground">
            {ticket.ticket_number}
          </p>
          <h1
            tabIndex={-1}
            className="text-xl font-semibold text-foreground"
          >
            {ticket.subject}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 capitalize ${STATUS_TONE[ticket.status] ?? ""}`}
            >
              {ticket.status.replace("_", " ")}
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 capitalize ${PRIORITY_TONE[ticket.priority] ?? ""}`}
            >
              {ticket.priority} priority
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PRODUCT_TONE[ticket.product_id] ?? "bg-muted text-muted-foreground"}`}
            >
              {ticket.product_id}
            </span>
            <Link
              href={`/admin/apps/${ticket.product_id}/tenants/${ticket.tenant_id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              View tenant →
            </Link>
          </div>
        </header>

        <dl className="grid grid-cols-3 gap-x-6 gap-y-2 border-y border-border py-4 text-xs">
          <div>
            <dt className="text-muted-foreground">Submitted by</dt>
            <dd className="mt-0.5 text-foreground">
              {ticket.submitted_by_name}{" "}
              <span className="text-muted-foreground">
                &lt;{ticket.submitted_by_email}&gt;
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Filed</dt>
            <dd className="mt-0.5 tabular-nums text-foreground">
              {new Date(ticket.created_at).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last activity</dt>
            <dd className="mt-0.5 tabular-nums text-foreground">
              {new Date(ticket.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>

        <section aria-labelledby="section-description" className="space-y-2">
          <h2
            id="section-description"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Original description
          </h2>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {ticket.description}
            </p>
          </div>
        </section>

        <section
          aria-label="Reply thread"
          aria-live="polite"
          aria-relevant="additions"
          className="space-y-3"
        >
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
            Replies ({replies.length})
          </h2>
          {replies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No replies yet. Be the first to respond.
            </p>
          ) : (
            <ul className="space-y-3">
              {replies.map((reply) => {
                const isAdmin = reply.author_type === "platform_admin";
                return (
                  <li key={reply.id}>
                    <article
                      className={`rounded-lg border border-border p-4 ${isAdmin ? "bg-muted/40" : "bg-card"}`}
                    >
                      <header className="mb-2 flex items-center justify-between gap-2 text-xs">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${isAdmin ? "bg-sidebar-accent text-sidebar-foreground" : "bg-muted text-muted-foreground"}`}
                        >
                          {isAdmin ? "Platform" : "Merchant"} ·{" "}
                          {reply.author_name}
                        </span>
                        <time
                          dateTime={reply.created_at}
                          className="tabular-nums text-muted-foreground"
                        >
                          {new Date(reply.created_at).toLocaleString()}
                        </time>
                      </header>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                        {reply.content}
                      </p>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {terminal ? (
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            <span>
              This ticket is {ticket.status}.{" "}
              {ticket.status === "resolved"
                ? "Reopen it to send a reply."
                : "Reopen to continue the conversation."}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={reopening}
              onClick={() => changeStatus("open")}
            >
              {reopening ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Reopen"
              )}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={sendReply}
            aria-label="Reply composer"
            className="space-y-3 rounded-lg border border-border bg-card p-4"
          >
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Reply to merchant…"
              aria-label="Reply to merchant"
              aria-describedby="composer-hint"
              className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p id="composer-hint" className="text-[10px] text-muted-foreground">
              Cmd+Return to send.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statusOnSend}
                onValueChange={(v) => setStatusOnSend(v as StatusOnSend)}
              >
                <SelectTrigger className="h-9 w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Just send</SelectItem>
                  <SelectItem value="in_progress">
                    Mark in progress on send
                  </SelectItem>
                  <SelectItem value="resolved">
                    Mark resolved on send
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="submit"
                size="sm"
                disabled={!content.trim() || submitting}
                aria-label="Send reply"
                className="ml-auto"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send reply"
                )}
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/platform-tickets"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="h-3 w-3" aria-hidden="true" />
      Back to tickets
    </Link>
  );
}
