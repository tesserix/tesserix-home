"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { type TemplateStatus, type EmailTemplate } from "@/lib/api/email-templates";
import { type CategoryConfig } from "@/lib/api/email-template-categories";
import { cn } from "@/lib/utils";

interface TemplateFiltersProps {
  templates: EmailTemplate[];
  statusFilter: TemplateStatus | "all";
  onStatusFilterChange: (status: TemplateStatus | "all") => void;
  categoryFilter: string | "all";
  onCategoryFilterChange: (category: string | "all") => void;
  categories: CategoryConfig[];
  search: string;
  onSearchChange: (search: string) => void;
}

function countByStatus(templates: EmailTemplate[], status: TemplateStatus | "all"): number {
  if (status === "all") return templates.length;
  return templates.filter((t) => t.status === status).length;
}

function countByCategory(templates: EmailTemplate[], category: string | "all"): number {
  if (category === "all") return templates.length;
  return templates.filter((t) => t.category === category).length;
}

export function TemplateFilters({
  templates,
  statusFilter,
  onStatusFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  categories,
  search,
  onSearchChange,
}: TemplateFiltersProps) {
  const statusOptions: { value: TemplateStatus | "all"; label: string }[] = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "draft", label: "Draft" },
    { value: "inactive", label: "Inactive" },
  ];

  return (
    <div className="space-y-3">
      {/* Status filter chips */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          {statusOptions.map((opt) => {
            const count = countByStatus(templates, opt.value);
            return (
              <button
                key={opt.value}
                onClick={() => onStatusFilterChange(opt.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {opt.label}
                <span
                  className={cn(
                    "text-[10px]",
                    statusFilter === opt.value
                      ? "text-primary-foreground/70"
                      : "text-muted-foreground/70"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative ml-auto">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-64 pl-9 h-8 text-sm"
          />
        </div>
      </div>

      {/* Category filter chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => onCategoryFilterChange("all")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
            categoryFilter === "all"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          )}
        >
          All Groups
          <span
            className={cn(
              "text-[10px]",
              categoryFilter === "all"
                ? "text-primary-foreground/70"
                : "text-muted-foreground/70"
            )}
          >
            {templates.length}
          </span>
        </button>
        {categories.map((cat) => {
          const count = countByCategory(templates, cat.value);
          return (
            <button
              key={cat.value}
              onClick={() => onCategoryFilterChange(cat.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                categoryFilter === cat.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {cat.label}
              <span
                className={cn(
                  "text-[10px]",
                  categoryFilter === cat.value
                    ? "text-primary-foreground/70"
                    : "text-muted-foreground/70"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
