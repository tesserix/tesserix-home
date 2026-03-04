"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import {
  Search,
  Filter,
  MoreHorizontal,
  Clock,
  ChevronRight,
  Building2,
  AlertCircle,
  MessageSquare,
  Tag,
  Ticket as TicketIcon,
  User,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent } from "@/components/ui/card";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { EmptyState, EmptyStateTitle, EmptyStateDescription } from "@/components/admin/empty-state";
import { useTickets, updateTicketStatus, type Ticket } from "@/lib/api/tickets";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

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

function useDebounce(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
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

export default function AppTicketsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, error, mutate } = useTickets({
    search: debouncedSearch || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    priority: priorityFilter !== "all" ? priorityFilter : undefined,
    page,
    limit: 20,
  });

  const tickets = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? Math.ceil(total / 20);

  // Compute summary stats from current data
  const openCount = tickets.filter((t: Ticket) => t.status?.toLowerCase() === "open").length;
  const inProgressCount = tickets.filter((t: Ticket) =>
    ["in_progress", "in-progress"].includes(t.status?.toLowerCase())
  ).length;
  const criticalCount = tickets.filter((t: Ticket) =>
    ["critical", "urgent", "high"].includes(t.priority?.toLowerCase())
  ).length;

  async function handleStatusChange(ticketId: string, newStatus: string, tenantId?: string) {
    const { error } = await updateTicketStatus(ticketId, newStatus, tenantId);
    if (!error) {
      mutate();
    }
  }

  return (
    <>
      <AdminHeader
        title="Support Tickets"
        description={`Manage support requests for ${appName}`}
        icon={<TicketIcon className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Tickets</span>
        </nav>

        {/* Summary cards */}
        {!isLoading && !error && (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Total</p>
                    <p className="text-2xl font-bold">{total}</p>
                  </div>
                  <TicketIcon className="h-5 w-5 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Open</p>
                    <p className="text-2xl font-bold text-blue-600">{openCount}</p>
                  </div>
                  <AlertCircle className="h-5 w-5 text-blue-500" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">In Progress</p>
                    <p className="text-2xl font-bold text-amber-600">{inProgressCount}</p>
                  </div>
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">High Priority</p>
                    <p className="text-2xl font-bold text-red-600">{criticalCount}</p>
                  </div>
                  <AlertCircle className="h-5 w-5 text-red-500" />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title, ticket number, or tenant..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-40">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="on_hold">On Hold</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={(v) => { setPriorityFilter(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priority</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Content */}
        {isLoading ? (
          <TableSkeleton columns={7} rows={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : tickets.length === 0 ? (
          <EmptyState>
            <EmptyStateTitle>No tickets found</EmptyStateTitle>
            <EmptyStateDescription>
              {search ? "Try adjusting your search or filters" : "No support tickets have been created yet."}
            </EmptyStateDescription>
          </EmptyState>
        ) : (
          <>
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Ticket</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map((ticket: Ticket) => (
                    <TableRow key={ticket.id} className="group">
                      <TableCell>
                        <Link
                          href={`/admin/apps/${slug}/tickets/${ticket.id}${ticket.tenant_id ? `?tenantId=${ticket.tenant_id}` : ''}`}
                          className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {ticket.ticket_number || ticket.id?.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Link
                            href={`/admin/apps/${slug}/tickets/${ticket.id}${ticket.tenant_id ? `?tenantId=${ticket.tenant_id}` : ''}`}
                            className="font-medium hover:underline line-clamp-1"
                          >
                            {ticket.title}
                          </Link>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            {ticket.created_by_name && (
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                {ticket.created_by_name}
                              </span>
                            )}
                            {ticket.type && (
                              <span className="flex items-center gap-1">
                                <Tag className="h-3 w-3" />
                                {ticket.type.toLowerCase().replace(/_/g, " ")}
                              </span>
                            )}
                            {Array.isArray(ticket.comments) && ticket.comments.length > 0 && (
                              <span className="flex items-center gap-1">
                                <MessageSquare className="h-3 w-3" />
                                {ticket.comments.length}
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {ticket.tenant_name ? (
                          <div className="flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <Link
                              href={`/admin/apps/${slug}/${ticket.tenant_id}`}
                              className="text-sm hover:underline truncate max-w-[140px]"
                              title={ticket.tenant_name}
                            >
                              {ticket.tenant_name}
                            </Link>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">&mdash;</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusColor(ticket.status)}>
                          {formatStatus(ticket.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getPriorityColor(ticket.priority)}>
                          {ticket.priority?.toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground whitespace-nowrap" title={
                          ticket.updated_at ? new Date(ticket.updated_at).toLocaleString() : undefined
                        }>
                          {timeAgo(ticket.updated_at || ticket.created_at)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/apps/${slug}/tickets/${ticket.id}${ticket.tenant_id ? `?tenantId=${ticket.tenant_id}` : ''}`}>
                                View Details
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {ticket.status?.toLowerCase() === "open" && (
                              <DropdownMenuItem onClick={() => handleStatusChange(ticket.id, "in_progress", ticket.tenant_id)}>
                                Mark as In Progress
                              </DropdownMenuItem>
                            )}
                            {["in_progress", "in-progress"].includes(ticket.status?.toLowerCase()) && (
                              <DropdownMenuItem onClick={() => handleStatusChange(ticket.id, "resolved", ticket.tenant_id)}>
                                Mark as Resolved
                              </DropdownMenuItem>
                            )}
                            {ticket.status?.toLowerCase() === "resolved" && (
                              <DropdownMenuItem onClick={() => handleStatusChange(ticket.id, "closed", ticket.tenant_id)}>
                                Close Ticket
                              </DropdownMenuItem>
                            )}
                            {!["escalated", "closed"].includes(ticket.status?.toLowerCase()) && (
                              <DropdownMenuItem
                                onClick={() => handleStatusChange(ticket.id, "escalated", ticket.tenant_id)}
                                className="text-destructive"
                              >
                                Escalate
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages || 1} ({total} ticket{total !== 1 ? "s" : ""})
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
