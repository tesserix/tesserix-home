"use client";

import { useState, useMemo, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Filter,
  MoreHorizontal,
  Plus,
  Globe,
  FileText,
  Menu as MenuIcon,
  ArrowDownToLine,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { AdminHeader } from "@/components/admin/header";
import { TenantSelector } from "@/components/admin/tenant-selector";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import {
  useContentPages,
  saveContentPages,
  deletePage,
  publishPage,
  unpublishPage,
  archivePage,
  type ContentPage,
  type ContentPageType,
  type ContentPageStatus,
} from "@/lib/api/content";
import {
  Button,
  Input,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  EmptyState,
  EmptyStateTitle,
  EmptyStateDescription,
  ConfirmDialog,
} from "@tesserix/web";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

function getStatusColor(status: ContentPageStatus) {
  switch (status) {
    case "PUBLISHED":
      return "success";
    case "DRAFT":
      return "warning";
    case "ARCHIVED":
      return "secondary";
    default:
      return "secondary";
  }
}

function getTypeColor(type: ContentPageType) {
  switch (type) {
    case "BLOG":
      return "info";
    case "FAQ":
      return "warning";
    case "POLICY":
      return "secondary";
    case "LANDING":
      return "success";
    case "STATIC":
      return "default";
    case "CUSTOM":
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

export default function AppContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const router = useRouter();
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [selectedTenantName, setSelectedTenantName] = useState<string>("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const debouncedSearch = useDebounce(search, 300);
  const [deletePageTarget, setDeletePageTarget] = useState<string | null>(null);
  const [deletePageLoading, setDeletePageLoading] = useState(false);

  const { data, isLoading, error, mutate } = useContentPages(selectedTenantId);
  const allPages = useMemo(() => data?.data ?? [], [data]);

  // Client-side filtering
  const filteredPages = useMemo(() => {
    let pages = allPages;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      pages = pages.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          p.excerpt?.toLowerCase().includes(q)
      );
    }

    if (typeFilter !== "all") {
      pages = pages.filter((p) => p.type === typeFilter);
    }

    if (statusFilter !== "all") {
      pages = pages.filter((p) => p.status === statusFilter);
    }

    // Sort by updatedAt descending
    return [...pages].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [allPages, debouncedSearch, typeFilter, statusFilter]);

  async function handleAction(
    action: "publish" | "unpublish" | "archive" | "delete",
    pageId: string
  ) {
    if (!selectedTenantId) return;

    let updatedPages: ContentPage[];
    switch (action) {
      case "publish":
        updatedPages = publishPage(allPages, pageId);
        break;
      case "unpublish":
        updatedPages = unpublishPage(allPages, pageId);
        break;
      case "archive":
        updatedPages = archivePage(allPages, pageId);
        break;
      case "delete":
        setDeletePageTarget(pageId);
        return;
    }

    const { error } = await saveContentPages(selectedTenantId, updatedPages);
    if (!error) {
      mutate();
    }
  }

  async function confirmDeletePage() {
    if (!selectedTenantId || !deletePageTarget) return;
    setDeletePageLoading(true);
    const updatedPages = deletePage(allPages, deletePageTarget);
    const { error } = await saveContentPages(selectedTenantId, updatedPages);
    setDeletePageLoading(false);
    if (!error) {
      mutate();
    }
    setDeletePageTarget(null);
  }

  return (
    <>
      <AdminHeader
        title="Content Pages"
        description={`Manage content pages for ${appName} storefronts`}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Content</span>
        </nav>

        {/* Tenant selector + New page button */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <TenantSelector
            value={selectedTenantId}
            onSelect={(id, name) => {
              setSelectedTenantId(id);
              setSelectedTenantName(name);
            }}
          />
          {selectedTenantId && (
            <Button
              onClick={() => router.push(`/admin/apps/${slug}/content/new?tenantId=${selectedTenantId}`)}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Page
            </Button>
          )}
        </div>

        {!selectedTenantId ? (
          <EmptyState>
            <EmptyStateTitle>Select a tenant</EmptyStateTitle>
            <EmptyStateDescription>Choose a tenant above to manage their content pages</EmptyStateDescription>
          </EmptyState>
        ) : (
          <>
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search pages..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                value={typeFilter}
                onValueChange={setTypeFilter}
              >
                <SelectTrigger className="w-full sm:w-40">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="STATIC">Static</SelectItem>
                  <SelectItem value="BLOG">Blog</SelectItem>
                  <SelectItem value="FAQ">FAQ</SelectItem>
                  <SelectItem value="POLICY">Policy</SelectItem>
                  <SelectItem value="LANDING">Landing</SelectItem>
                  <SelectItem value="CUSTOM">Custom</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={setStatusFilter}
              >
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="PUBLISHED">Published</SelectItem>
                  <SelectItem value="ARCHIVED">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Content */}
            {isLoading ? (
              <TableSkeleton columns={6} rows={5} />
            ) : error ? (
              <ErrorState message={error} onRetry={mutate} />
            ) : filteredPages.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No content pages found</EmptyStateTitle>
                <EmptyStateDescription>
                  {search || typeFilter !== "all" || statusFilter !== "all"
                    ? "Try adjusting your search or filters"
                    : `Create the first content page for ${selectedTenantName}`}
                </EmptyStateDescription>
              </EmptyState>
            ) : (
              <>
                <div className="rounded-lg border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Title</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Display</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead className="w-10"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPages.map((page: ContentPage) => (
                        <TableRow key={page.id}>
                          <TableCell>
                            <Button
                              variant="link"
                              onClick={() =>
                                router.push(
                                  `/admin/apps/${slug}/content/${page.id}?tenantId=${selectedTenantId}`
                                )
                              }
                              className="h-auto p-0 text-left font-medium"
                            >
                              {page.title}
                            </Button>
                            <p className="text-sm text-muted-foreground">
                              /{page.slug}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getTypeColor(page.type)}>
                              {page.type.toLowerCase()}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getStatusColor(page.status)}>
                              {page.status.toLowerCase()}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {page.showInMenu && (
                                <span title="Shown in menu">
                                  <MenuIcon className="h-4 w-4 text-muted-foreground" />
                                </span>
                              )}
                              {page.showInFooter && (
                                <span title="Shown in footer">
                                  <ArrowDownToLine className="h-4 w-4 text-muted-foreground" />
                                </span>
                              )}
                              {page.isFeatured && (
                                <span title="Featured">
                                  <Globe className="h-4 w-4 text-muted-foreground" />
                                </span>
                              )}
                              {!page.showInMenu &&
                                !page.showInFooter &&
                                !page.isFeatured && (
                                  <span className="text-sm text-muted-foreground">
                                    -
                                  </span>
                                )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {new Date(page.updatedAt).toLocaleDateString()}
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
                                <DropdownMenuItem
                                  onClick={() =>
                                    router.push(
                                      `/admin/apps/${slug}/content/${page.id}?tenantId=${selectedTenantId}`
                                    )
                                  }
                                >
                                  <FileText className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {page.status === "DRAFT" && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      handleAction("publish", page.id)
                                    }
                                  >
                                    <Globe className="mr-2 h-4 w-4" />
                                    Publish
                                  </DropdownMenuItem>
                                )}
                                {page.status === "PUBLISHED" && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      handleAction("unpublish", page.id)
                                    }
                                  >
                                    Unpublish
                                  </DropdownMenuItem>
                                )}
                                {page.status !== "ARCHIVED" && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      handleAction("archive", page.id)
                                    }
                                  >
                                    Archive
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() =>
                                    handleAction("delete", page.id)
                                  }
                                >
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <p className="text-sm text-muted-foreground">
                  Showing {filteredPages.length} of {allPages.length} pages
                </p>
              </>
            )}
          </>
        )}

        <ConfirmDialog
          open={!!deletePageTarget}
          onOpenChange={(open) => { if (!open) setDeletePageTarget(null); }}
          title="Delete Page"
          description="Are you sure you want to delete this page? This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={confirmDeletePage}
          loading={deletePageLoading}
        />
      </main>
    </>
  );
}
