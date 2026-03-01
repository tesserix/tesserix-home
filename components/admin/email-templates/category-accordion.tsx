"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TemplateCard } from "./template-card";
import { type EmailTemplate } from "@/lib/api/email-templates";
import { type CategoryConfig } from "@/lib/api/email-template-categories";

interface CategoryAccordionProps {
  category: CategoryConfig;
  templates: EmailTemplate[];
  basePath: string;
  defaultOpen?: boolean;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function CategoryAccordion({
  category,
  templates,
  basePath,
  defaultOpen = false,
  onDuplicate,
  onDelete,
}: CategoryAccordionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border">
      <button
        className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3">
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{category.label}</span>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {templates.length}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{category.description}</p>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3">
          {templates.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                No templates in {category.label}
              </p>
              <Link href={`${basePath}/new?category=${category.value}`}>
                <Button variant="outline" size="sm">
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  Create Template
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  basePath={basePath}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
