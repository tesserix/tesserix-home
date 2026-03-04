"use client";

import { Search } from "lucide-react";
import { type TemplateStatus, type EmailTemplate } from "@/lib/api/email-templates";
import { type CategoryConfig } from "@/lib/api/email-template-categories";
import { Input, Button, Badge } from "@tesserix/web";

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
            const isActive = statusFilter === opt.value;
            return (
              <Button
                key={opt.value}
                type="button"
                size="sm"
                variant={isActive ? "default" : "outline"}
                onClick={() => onStatusFilterChange(opt.value)}
                className="h-7 gap-1.5 rounded-full px-3 text-xs"
              >
                {opt.label}
                <Badge variant={isActive ? "secondary" : "outline"} className="text-[10px]">
                  {count}
                </Badge>
              </Button>
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
        <Button
          type="button"
          size="sm"
          variant={categoryFilter === "all" ? "default" : "outline"}
          onClick={() => onCategoryFilterChange("all")}
          className="h-7 gap-1.5 rounded-full px-3 text-xs"
        >
          All Groups
          <Badge
            variant={categoryFilter === "all" ? "secondary" : "outline"}
            className="text-[10px]"
          >
            {templates.length}
          </Badge>
        </Button>
        {categories.map((cat) => {
          const count = countByCategory(templates, cat.value);
          const isActive = categoryFilter === cat.value;
          return (
            <Button
              key={cat.value}
              type="button"
              size="sm"
              variant={isActive ? "default" : "outline"}
              onClick={() => onCategoryFilterChange(cat.value)}
              className="h-7 gap-1.5 rounded-full px-3 text-xs"
            >
              {cat.label}
              <Badge variant={isActive ? "secondary" : "outline"} className="text-[10px]">
                {count}
              </Badge>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
