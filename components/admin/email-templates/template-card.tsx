"use client";

import { useState } from "react";
import Link from "next/link";
import { Lock, MoreHorizontal, Pencil, Copy, Send, Trash2, Eye, Mail } from "lucide-react";
import { TemplatePreviewDialog } from "./template-preview-dialog";
import { type EmailTemplate, type TemplateStatus } from "@/lib/api/email-templates";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@tesserix/web";

function statusVariant(status: TemplateStatus): "success" | "destructive" | "secondary" {
  switch (status) {
    case "active":
      return "success";
    case "inactive":
      return "destructive";
    case "draft":
    default:
      return "secondary";
  }
}

interface TemplateCardProps {
  template: EmailTemplate;
  basePath: string;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function TemplateCard({ template, basePath, onDuplicate, onDelete }: TemplateCardProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isSystem = template.is_system;

  return (
    <>
      <div
        className={`group relative rounded-lg border p-4 transition-all hover:shadow-sm ${
          isSystem
            ? "bg-muted/10 border-muted"
            : "hover:border-foreground/20"
        }`}
      >
        {/* Top row: icon + name + menu */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
              <Mail className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {isSystem && <Lock className="h-3 w-3 text-muted-foreground shrink-0" />}
                <Link
                  href={`${basePath}/${template.id}`}
                  className="font-medium text-sm hover:underline truncate block"
                >
                  {template.name}
                </Link>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {template.description || template.subject || "No subject"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Preview button — visible on hover */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => setPreviewOpen(true)}
              title="Preview"
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setPreviewOpen(true)}>
                  <Eye className="mr-2 h-4 w-4" />
                  Preview
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`${basePath}/${template.id}`}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {isSystem ? "View" : "Edit"}
                  </Link>
                </DropdownMenuItem>
                {onDuplicate && (
                  <DropdownMenuItem onClick={() => onDuplicate(template.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href={`${basePath}/${template.id}?test=true`}>
                    <Send className="mr-2 h-4 w-4" />
                    Test Send
                  </Link>
                </DropdownMenuItem>
                {!isSystem && onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(template.id)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Bottom row: badges */}
        <div className="flex items-center gap-1.5 mt-3 ml-11">
          <Badge variant={statusVariant(template.status)} className="text-[10px] px-1.5 py-0">
            {template.status}
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {template.type}
          </Badge>
          {isSystem && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              System
            </Badge>
          )}
        </div>
      </div>

      <TemplatePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        template={template}
      />
    </>
  );
}
