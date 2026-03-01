"use client";

import { use, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  User,
  Building2,
  Send,
  Tag,
  AlertTriangle,
  Calendar,
  MessageSquare,
  History,
  Mail,
  Paperclip,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ErrorState } from "@/components/admin/error-state";
import { useTicket, updateTicketStatus, addTicketComment, type TicketComment } from "@/lib/api/tickets";

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "open":
      return "info";
    case "in_progress":
    case "in-progress":
      return "warning";
    case "resolved":
      return "success";
    case "closed":
      return "secondary";
    case "escalated":
      return "destructive";
    default:
      return "secondary";
  }
}

function getPriorityColor(priority: string) {
  switch (priority?.toLowerCase()) {
    case "high":
    case "critical":
    case "urgent":
      return "destructive";
    case "medium":
      return "warning";
    case "low":
      return "secondary";
    default:
      return "secondary";
  }
}

function formatStatus(status: string) {
  return status?.toLowerCase().replace(/_/g, " ") || "";
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return date.toLocaleDateString();
}

function SlaCard({ sla }: { sla: Record<string, unknown> }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">SLA</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {sla.response_time != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Response Time</span>
            <span>{String(sla.response_time)}</span>
          </div>
        )}
        {sla.resolution_time != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Resolution Time</span>
            <span>{String(sla.resolution_time)}</span>
          </div>
        )}
        {sla.status != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">SLA Status</span>
            <Badge variant={
              String(sla.status).toLowerCase() === "met" ? "success" : "destructive"
            }>
              {String(sla.status)}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-40 mt-2" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader><Skeleton className="h-5 w-20" /></CardHeader>
          <CardContent><Skeleton className="h-10 w-full" /></CardContent>
        </Card>
        <Card>
          <CardHeader><Skeleton className="h-5 w-20" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function AppTicketDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId");

  const { data: ticket, isLoading, error, mutate } = useTicket(id, tenantId);
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);

  const currentStatus = ticket?.status?.toLowerCase() || "open";

  // Use tenantId from URL param, fallback to ticket data
  const effectiveTenantId = tenantId || ticket?.tenant_id || null;

  async function handleStatusChange(newStatus: string) {
    setStatusUpdating(true);
    const { error } = await updateTicketStatus(id, newStatus, effectiveTenantId);
    setStatusUpdating(false);
    if (!error) {
      mutate();
    }
  }

  async function handleSubmitComment() {
    if (!newComment.trim() || submitting) return;

    setSubmitting(true);
    const { error } = await addTicketComment(id, newComment.trim(), false, effectiveTenantId);
    setSubmitting(false);

    if (!error) {
      setNewComment("");
      mutate();
    }
  }

  return (
    <>
      <AdminHeader title={ticket ? `Ticket ${ticket.ticket_number || ticket.id?.slice(0, 8)}` : "Ticket"} />

      <main className="p-6 space-y-6">
        {/* Back link + ticket meta */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/admin/apps/${slug}/tickets`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Tickets
            </Link>
          </Button>
          {ticket && (
            <div className="flex items-center gap-2">
              <Badge variant={getPriorityColor(ticket.priority)}>
                {ticket.priority?.toLowerCase()}
              </Badge>
              <Badge variant={getStatusColor(ticket.status)}>
                {formatStatus(ticket.status)}
              </Badge>
            </div>
          )}
        </div>

        {isLoading ? (
          <DetailSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : !ticket ? (
          <ErrorState message="Ticket not found" />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Main content */}
            <div className="lg:col-span-2 space-y-6">
              {/* Ticket header + description */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-xl">{ticket.title}</CardTitle>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                    {ticket.ticket_number && (
                      <span className="font-mono">#{ticket.ticket_number}</span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      Created {ticket.created_at ? timeAgo(ticket.created_at) : "-"}
                    </span>
                    {ticket.updated_at && ticket.updated_at !== ticket.created_at && (
                      <span className="flex items-center gap-1">
                        <History className="h-3.5 w-3.5" />
                        Updated {timeAgo(ticket.updated_at)}
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-foreground whitespace-pre-wrap leading-relaxed">
                    {ticket.description || "No description provided."}
                  </p>
                  {ticket.tags && ticket.tags.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {ticket.tags.map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          <Tag className="h-3 w-3 mr-1" />
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Comments section */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-base">
                      Comments
                      {ticket.comments && ticket.comments.length > 0 && (
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                          ({ticket.comments.length})
                        </span>
                      )}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {ticket.comments && ticket.comments.length > 0 ? (
                    <div className="space-y-4">
                      {ticket.comments.map((comment: TicketComment, idx: number) => {
                        const authorName = comment.author?.name || comment.userName || comment.created_by_name || "Unknown";
                        const authorRole = comment.author?.role || "user";
                        const commentTime = comment.created_at || comment.createdAt;
                        return (
                          <div key={comment.id || idx} className="flex gap-3 p-3 rounded-lg bg-muted/40">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs">
                                {getInitials(authorName)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-sm">{authorName}</span>
                                <Badge
                                  variant={authorRole === "admin" ? "default" : "secondary"}
                                  className="text-[10px] px-1.5 py-0"
                                >
                                  {authorRole}
                                </Badge>
                                {commentTime && commentTime !== "0001-01-01T00:00:00Z" && (
                                  <span className="text-xs text-muted-foreground">
                                    {timeAgo(commentTime)}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">
                                {comment.content}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-muted-foreground">
                      <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No comments yet. Start the conversation.</p>
                    </div>
                  )}

                  <Separator />

                  {/* New comment form */}
                  <div className="space-y-3">
                    <Textarea
                      placeholder="Write a reply..."
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      rows={3}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          handleSubmitComment();
                        }
                      }}
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        Press Cmd+Enter to send
                      </span>
                      <Button
                        onClick={handleSubmitComment}
                        disabled={!newComment.trim() || submitting}
                        size="sm"
                      >
                        <Send className="mr-2 h-4 w-4" />
                        {submitting ? "Sending..." : "Send Reply"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* History timeline */}
              {Array.isArray(ticket.history) && ticket.history.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <History className="h-5 w-5 text-muted-foreground" />
                      <CardTitle className="text-base">Activity History</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {ticket.history.map((entry: Record<string, unknown>, i: number) => (
                        <div key={i} className="flex items-start gap-3 text-sm">
                          <div className="mt-1 h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                          <div className="flex-1">
                            <p className="text-foreground">
                              {String(entry.description || entry.action || entry.change || "")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {entry.created_at || entry.timestamp
                                ? timeAgo(String(entry.created_at || entry.timestamp))
                                : ""}
                              {entry.user_name || entry.actor
                                ? ` by ${String(entry.user_name || entry.actor)}`
                                : ""}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Status actions */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <Select
                    value={currentStatus}
                    onValueChange={handleStatusChange}
                    disabled={statusUpdating}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="on_hold">On Hold</SelectItem>
                      <SelectItem value="resolved">Resolved</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                      <SelectItem value="escalated">Escalated</SelectItem>
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              {/* Ticket details */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Tenant */}
                  {(ticket.tenant_id || effectiveTenantId) && (
                    <div className="flex items-center gap-3">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Tenant</p>
                        <Link
                          href={`/admin/apps/${slug}/${ticket.tenant_id || effectiveTenantId}`}
                          className="font-medium text-sm text-primary hover:underline truncate block"
                        >
                          {ticket.tenant_name || ticket.tenant_id || effectiveTenantId}
                        </Link>
                      </div>
                    </div>
                  )}

                  {/* Created by */}
                  {(ticket.created_by_name || ticket.created_by_email) && (
                    <div className="flex items-center gap-3">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Created by</p>
                        <p className="font-medium text-sm">{ticket.created_by_name || "-"}</p>
                        {ticket.created_by_email && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {ticket.created_by_email}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Type */}
                  {ticket.type && (
                    <div className="flex items-center gap-3">
                      <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Type</p>
                        <Badge variant="secondary" className="mt-0.5">
                          {ticket.type.toLowerCase().replace(/_/g, " ")}
                        </Badge>
                      </div>
                    </div>
                  )}

                  {/* Priority */}
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Priority</p>
                      <Badge variant={getPriorityColor(ticket.priority)} className="mt-0.5">
                        {ticket.priority?.toLowerCase()}
                      </Badge>
                    </div>
                  </div>

                  {/* Due date */}
                  {ticket.due_date && (
                    <div className="flex items-center gap-3">
                      <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Due Date</p>
                        <p className="font-medium text-sm">
                          {new Date(ticket.due_date).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Created / Updated timestamps */}
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Created</p>
                      <p className="text-sm">
                        {ticket.created_at
                          ? new Date(ticket.created_at).toLocaleString()
                          : "-"}
                      </p>
                    </div>
                  </div>
                  {ticket.updated_at && (
                    <div className="flex items-center gap-3">
                      <History className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Last Updated</p>
                        <p className="text-sm">
                          {new Date(ticket.updated_at).toLocaleString()}
                        </p>
                        {ticket.updated_by && (
                          <p className="text-xs text-muted-foreground">
                            by {ticket.updated_by}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Assignees */}
              {Array.isArray(ticket.assignees) && ticket.assignees.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Assignees</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {ticket.assignees.map((assignee: { id: string; name: string; email: string }) => (
                      <div key={assignee.id} className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className="text-xs">
                            {getInitials(assignee.name || "?")}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{assignee.name}</p>
                          {assignee.email && (
                            <p className="text-xs text-muted-foreground truncate">{assignee.email}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Attachments */}
              {Array.isArray(ticket.attachments) && ticket.attachments.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-base">
                        Attachments ({ticket.attachments.length})
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {ticket.attachments.map((att: Record<string, unknown>, i: number) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 p-2 rounded border text-sm"
                      >
                        <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">
                          {String(att.filename || att.name || `Attachment ${i + 1}`)}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* SLA info */}
              {ticket.sla && typeof ticket.sla === "object" && (
                <SlaCard sla={ticket.sla as Record<string, unknown>} />
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
