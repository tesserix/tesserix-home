"use client";

import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@tesserix/web";
import { Search, Filter, MoreHorizontal, ExternalLink, ChevronRight, Globe, Trash2 } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { EmptyState } from "@/components/admin/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useTenants,
  deleteTenant,
  batchDeleteTenants,
  deleteAllTenants,
  type Tenant,
} from "@/lib/api/tenants";

const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || "tesserix.app";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "active":
      return "success";
    case "pending":
      return "warning";
    case "suspended":
      return "destructive";
    default:
      return "secondary";
  }
}

function useDebounce(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

type DeleteMode = "single" | "batch" | "all" | null;

export default function AppTenantsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Delete dialog state
  const [deleteMode, setDeleteMode] = useState<DeleteMode>(null);
  const [deleteSingleTenant, setDeleteSingleTenant] = useState<Tenant | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const { data, isLoading, error, mutate } = useTenants({
    search: debouncedSearch || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    page,
    limit: 20,
  });

  const tenants = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const totalPages = Math.ceil(total / pageSize);

  // Clear selection when data changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [debouncedSearch, statusFilter, page]);

  const allOnPageSelected = tenants.length > 0 && tenants.every((t: Tenant) => selectedIds.has(t.id));

  const toggleSelectAll = useCallback(() => {
    if (allOnPageSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tenants.map((t: Tenant) => t.id)));
    }
  }, [allOnPageSelected, tenants]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // --- Delete handlers ---

  const openSingleDelete = (tenant: Tenant) => {
    setDeleteSingleTenant(tenant);
    setDeleteReason("");
    setDeleteMode("single");
  };

  const openBatchDelete = () => {
    setDeleteReason("");
    setDeleteMode("batch");
  };

  const openDeleteAll = () => {
    setDeleteReason("");
    setDeleteAllConfirmation("");
    setDeleteMode("all");
  };

  const closeDeleteDialog = () => {
    setDeleteMode(null);
    setDeleteSingleTenant(null);
    setDeleteReason("");
    setDeleteAllConfirmation("");
  };

  const handleConfirmDelete = async () => {
    setDeleteLoading(true);
    try {
      if (deleteMode === "single" && deleteSingleTenant) {
        const res = await deleteTenant(deleteSingleTenant.id, deleteReason);
        if (res.error) {
          toast({ title: "Failed to delete tenant", description: res.error, variant: "destructive" });
          return;
        }
        toast({ title: `Tenant "${deleteSingleTenant.name}" deleted`, variant: "success" });
      } else if (deleteMode === "batch") {
        const ids = Array.from(selectedIds);
        const res = await batchDeleteTenants(ids, deleteReason);
        if (res.error) {
          toast({ title: "Batch delete failed", description: res.error, variant: "destructive" });
          return;
        }
        toast({ title: `${ids.length} tenant${ids.length === 1 ? "" : "s"} deleted`, variant: "success" });
        setSelectedIds(new Set());
      } else if (deleteMode === "all") {
        const res = await deleteAllTenants(deleteAllConfirmation, deleteReason);
        if (res.error) {
          toast({ title: "Delete all failed", description: res.error, variant: "destructive" });
          return;
        }
        toast({ title: "All tenants deleted", variant: "success" });
      }
      closeDeleteDialog();
      mutate();
    } catch (err) {
      toast({ title: "Delete operation failed", description: String(err), variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  // Dialog content based on mode
  const getDeleteDialogProps = () => {
    switch (deleteMode) {
      case "single":
        return {
          title: "Delete Tenant",
          description: `Are you sure you want to permanently delete "${deleteSingleTenant?.name}" (${deleteSingleTenant?.slug})? This will remove all data across all databases and cannot be undone.`,
          confirmLabel: "Delete Tenant",
        };
      case "batch":
        return {
          title: `Delete ${selectedIds.size} Tenant${selectedIds.size === 1 ? "" : "s"}`,
          description: `Are you sure you want to permanently delete ${selectedIds.size} selected tenant${selectedIds.size === 1 ? "" : "s"}? This will remove all data across all databases and cannot be undone.`,
          confirmLabel: `Delete ${selectedIds.size} Tenant${selectedIds.size === 1 ? "" : "s"}`,
        };
      case "all":
        return {
          title: "Delete All Tenants",
          description: `This will permanently delete ALL ${total} tenants and all their data across all databases. This action cannot be undone.`,
          confirmLabel: "Delete All Tenants",
        };
      default:
        return { title: "", description: "", confirmLabel: "" };
    }
  };

  const dialogProps = getDeleteDialogProps();

  return (
    <>
      <AdminHeader
        title={`${appName} Tenants`}
        description={`Manage tenants for ${appName}`}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Tenants</span>
        </nav>

        {/* Filters & Bulk Actions */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tenants..."
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
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>

          {/* Batch action buttons */}
          {selectedIds.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={openBatchDelete}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete Selected ({selectedIds.size})
            </Button>
          )}
          {tenants.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={openDeleteAll}
              className="gap-2 text-destructive border-destructive/50 hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              Delete All
            </Button>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          <TableSkeleton columns={8} rows={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : tenants.length === 0 ? (
          <EmptyState
            message="No tenants found"
            description={search ? "Try adjusting your search or filters" : undefined}
          />
        ) : (
          <>
            {/* Table */}
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-gray-300 cursor-pointer accent-primary"
                        aria-label="Select all tenants on this page"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((tenant: Tenant) => (
                    <TableRow key={tenant.id} data-state={selectedIds.has(tenant.id) ? "selected" : undefined}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(tenant.id)}
                          onChange={() => toggleSelect(tenant.id)}
                          className="h-4 w-4 rounded border-gray-300 cursor-pointer accent-primary"
                          aria-label={`Select ${tenant.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/apps/${slug}/${tenant.id}`}
                          className="font-medium hover:underline"
                        >
                          {tenant.name}
                        </Link>
                        <p className="text-sm text-muted-foreground">{tenant.slug}</p>
                      </TableCell>
                      <TableCell>
                        {tenant.custom_domain && tenant.use_custom_domain ? (
                          <div className="flex items-center gap-2">
                            <a
                              href={`https://${tenant.custom_domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary hover:underline text-sm"
                            >
                              <Globe className="h-3 w-3" />
                              {tenant.custom_domain}
                            </a>
                            <Badge variant="outline" className="text-xs px-1.5 py-0">Custom</Badge>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {tenant.slug}.{BASE_DOMAIN}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{tenant.email || "-"}</TableCell>
                      <TableCell>
                        {tenant.status && (
                          <Badge variant={getStatusColor(tenant.status)}>
                            {tenant.status}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {tenant.plan ? (
                          <Badge variant="secondary">{tenant.plan}</Badge>
                        ) : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.created_at
                          ? new Date(tenant.created_at).toLocaleDateString()
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/apps/${slug}/${tenant.id}`}>
                                View Details
                              </Link>
                            </DropdownMenuItem>
                            {tenant.slug && (
                              <DropdownMenuItem asChild>
                                <a
                                  href={`https://${tenant.slug}.${BASE_DOMAIN}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  Visit Store
                                </a>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => openSingleDelete(tenant)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete Tenant
                            </DropdownMenuItem>
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
                Showing {tenants.length} of {total} tenants
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

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteMode !== null}
        onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}
        title={dialogProps.title}
        description={dialogProps.description}
        confirmLabel={dialogProps.confirmLabel}
        variant="destructive"
        onConfirm={handleConfirmDelete}
        loading={deleteLoading}
        confirmDisabled={deleteMode === "all" && deleteAllConfirmation !== "DELETE ALL TENANTS"}
      >
        <div className="space-y-4 py-2">
          {deleteMode === "all" && (
            <div className="space-y-2">
              <Label htmlFor="delete-all-confirm">
                Type <span className="font-mono font-bold">DELETE ALL TENANTS</span> to confirm
              </Label>
              <Input
                id="delete-all-confirm"
                value={deleteAllConfirmation}
                onChange={(e) => setDeleteAllConfirmation(e.target.value)}
                placeholder="DELETE ALL TENANTS"
                className="font-mono"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="delete-reason">Reason (optional)</Label>
            <Textarea
              id="delete-reason"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Why is this tenant being deleted?"
              rows={2}
            />
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}
