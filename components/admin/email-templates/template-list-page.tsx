"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { Plus, ChevronRight } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TemplateFilters } from "./template-filters";
import { CategoryAccordion } from "./category-accordion";
import { NotificationLog } from "./notification-log";
import {
  useEmailTemplatesByScope,
  deleteTemplate,
  duplicateTemplate,
  type EmailTemplate,
  type TemplateStatus,
} from "@/lib/api/email-templates";
import {
  type TemplateScope,
  getCategoriesForScope,
  type CategoryConfig,
} from "@/lib/api/email-template-categories";

interface TemplateListPageProps {
  scope: TemplateScope;
  basePath: string;
  title: string;
  description: string;
  breadcrumb?: { label: string; href: string };
}

export function TemplateListPage({
  scope,
  basePath,
  title,
  description,
  breadcrumb,
}: TemplateListPageProps) {
  const [activeTab, setActiveTab] = useState<"templates" | "notifications">("templates");
  const [statusFilter, setStatusFilter] = useState<TemplateStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const {
    data: templates,
    isLoading,
    error,
    mutate,
  } = useEmailTemplatesByScope(scope);

  const categories = useMemo(() => getCategoriesForScope(scope), [scope]);

  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    let result = templates;

    if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.subject.toLowerCase().includes(q)
      );
    }

    return result;
  }, [templates, statusFilter, search]);

  // Group templates by category for accordion display
  const templatesByCategory = useMemo(() => {
    const map = new Map<string, EmailTemplate[]>();
    for (const cat of categories) {
      map.set(cat.value, []);
    }
    // Also add an "uncategorized" bucket
    map.set("uncategorized", []);

    for (const t of filteredTemplates) {
      const key = t.category && map.has(t.category) ? t.category : "uncategorized";
      map.get(key)!.push(t);
    }
    return map;
  }, [filteredTemplates, categories]);

  // Which categories to display based on category filter
  const visibleCategories = useMemo(() => {
    if (categoryFilter === "all") return categories;
    return categories.filter((c) => c.value === categoryFilter);
  }, [categories, categoryFilter]);

  const uncategorizedTemplates = templatesByCategory.get("uncategorized") || [];

  async function handleDuplicate(id: string) {
    const result = await duplicateTemplate(id);
    if (result.data) {
      mutate();
    }
  }

  function handleDelete(id: string) {
    setDeleteTarget(id);
  }

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    await deleteTemplate(deleteTarget);
    setDeleteLoading(false);
    setDeleteTarget(null);
    mutate();
  }, [deleteTarget, mutate]);

  return (
    <>
      <AdminHeader title={title} description={description} />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        {breadcrumb && (
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
            <Link
              href={breadcrumb.href}
              className="hover:text-foreground transition-colors"
            >
              {breadcrumb.label}
            </Link>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground font-medium">Email Templates</span>
          </nav>
        )}

        {/* Tabs */}
        <div className="flex items-center justify-between">
          <div className="flex gap-2 border-b">
            <button
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "templates"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("templates")}
            >
              Templates
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "notifications"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("notifications")}
            >
              Notification Log
            </button>
          </div>
          {activeTab === "templates" && (
            <Link href={`${basePath}/new`}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Template
              </Button>
            </Link>
          )}
        </div>

        {/* Templates tab */}
        {activeTab === "templates" && (
          <>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : error ? (
              <ErrorState message={error} onRetry={mutate} />
            ) : (
              <>
                <TemplateFilters
                  templates={templates || []}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  categoryFilter={categoryFilter}
                  onCategoryFilterChange={setCategoryFilter}
                  categories={categories}
                  search={search}
                  onSearchChange={setSearch}
                />

                <div className="space-y-3">
                  {visibleCategories.map((cat) => (
                    <CategoryAccordion
                      key={cat.value}
                      category={cat}
                      templates={templatesByCategory.get(cat.value) || []}
                      basePath={basePath}
                      defaultOpen={categoryFilter !== "all"}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDelete}
                    />
                  ))}

                  {/* Uncategorized templates — only show if "all" filter and there are some */}
                  {categoryFilter === "all" && uncategorizedTemplates.length > 0 && (
                    <CategoryAccordion
                      category={{
                        value: "uncategorized",
                        label: "Uncategorized",
                        description: "Templates without a category",
                        scope,
                        variables: [],
                      }}
                      templates={uncategorizedTemplates}
                      basePath={basePath}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDelete}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* Notification log tab */}
        {activeTab === "notifications" && <NotificationLog />}
      </main>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete Template"
        description="Are you sure you want to delete this template? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
        loading={deleteLoading}
      />
    </>
  );
}
