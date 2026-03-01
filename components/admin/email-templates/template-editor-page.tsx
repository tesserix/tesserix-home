"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Save, Trash2, Send, Lock, ChevronDown, Eye } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { VariablesPanel } from "./variables-panel";
import { TemplatePreviewDialog } from "./template-preview-dialog";
import {
  useEmailTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  testSendTemplate,
  type EmailTemplate,
  type TemplateStatus,
} from "@/lib/api/email-templates";
import {
  type TemplateScope,
  getCategoriesForScope,
  getCategoryConfig,
  type CategoryConfig,
} from "@/lib/api/email-template-categories";

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

interface TemplateEditorPageProps {
  scope: TemplateScope;
  basePath: string;
  templateId: string;
}

export function TemplateEditorPage({ scope, basePath, templateId }: TemplateEditorPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNew = templateId === "new";

  const {
    data: template,
    isLoading,
    error,
    mutate,
  } = useEmailTemplate(isNew ? null : templateId);

  const categories = useMemo(() => getCategoriesForScope(scope), [scope]);

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [type, setType] = useState("transactional");
  const [category, setCategory] = useState(searchParams.get("category") || "");
  const [status, setStatus] = useState<TemplateStatus>("draft");
  const [htmlBody, setHtmlBody] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [testRecipient, setTestRecipient] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isSystem = template?.is_system;
  const categoryConfig = getCategoryConfig(category);

  useEffect(() => {
    if (template) {
      setName(template.name);
      setSubject(template.subject);
      setType(template.type);
      setCategory(template.category || "");
      setStatus(template.status);
      setHtmlBody(template.html_body);
      setVariables(template.variables || []);
    }
  }, [template]);

  async function handleSave() {
    setSaving(true);
    const data: Partial<EmailTemplate> = {
      name,
      subject,
      type,
      category: category || undefined,
      status,
      html_body: htmlBody,
      variables,
    };

    if (isNew) {
      const result = await createTemplate(data);
      setSaving(false);
      if (result.data) {
        router.push(`${basePath}/${result.data.id}`);
      }
    } else {
      await updateTemplate(templateId, data);
      setSaving(false);
      mutate();
    }
  }

  function handleDelete() {
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    setDeleting(true);
    await deleteTemplate(templateId);
    setDeleting(false);
    setDeleteOpen(false);
    router.push(basePath);
  }

  async function handleTestSend() {
    if (!testRecipient) return;
    setSending(true);
    await testSendTemplate(templateId, { recipient: testRecipient });
    setSending(false);
  }

  if (!isNew && isLoading) {
    return (
      <>
        <AdminHeader title="Email Template" description="Loading..." />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        </main>
      </>
    );
  }

  if (!isNew && error) {
    return (
      <>
        <AdminHeader title="Email Template" />
        <main className="p-6">
          <ErrorState message={error} onRetry={mutate} />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        title={isNew ? "New Email Template" : name || "Email Template"}
        description={isNew ? "Create a new email template" : "Edit template"}
      />

      <main className="p-6 space-y-6">
        {/* Action bar */}
        <div className="flex items-center justify-between">
          <Link
            href={basePath}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Templates
          </Link>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setPreviewOpen(true)}
              disabled={!htmlBody}
            >
              <Eye className="mr-2 h-4 w-4" />
              Preview
            </Button>
            {isSystem && (
              <Badge variant="secondary" className="gap-1">
                <Lock className="h-3 w-3" />
                System Template
              </Badge>
            )}
            {!isNew && !isSystem && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            )}
            <Button onClick={handleSave} disabled={saving || isSystem}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column - Editor */}
          <div className="lg:col-span-2 space-y-4">
            <div>
              <label className="text-sm font-medium">Template Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Welcome Email"
                className="mt-1"
                disabled={isSystem}
              />
            </div>

            <div>
              <label className="text-sm font-medium">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                disabled={isSystem}
              >
                <option value="">No category</option>
                {categories.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Subject Line</label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g., Welcome to {{company_name}}"
                className="mt-1"
                disabled={isSystem}
              />
            </div>

            {/* Collapsible variable picker */}
            {categoryConfig && categoryConfig.variables.length > 0 && (
              <div className="rounded-md border">
                <button
                  className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => setVariablesExpanded(!variablesExpanded)}
                >
                  <span className="text-sm font-medium">
                    Available Variables ({categoryConfig.variables.length})
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${
                      variablesExpanded ? "" : "-rotate-90"
                    }`}
                  />
                </button>
                {variablesExpanded && (
                  <div className="border-t p-3">
                    <VariablesPanel category={categoryConfig} compact />
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="text-sm font-medium">HTML Body</label>
              <textarea
                value={htmlBody}
                onChange={(e) => setHtmlBody(e.target.value)}
                placeholder="<html>...</html>"
                rows={20}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={isSystem}
              />
            </div>
          </div>

          {/* Right column - Settings */}
          <div className="space-y-4">
            {/* Scope indicator */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Scope</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge variant={scope === "platform" ? "info" : "default"}>
                  {scope === "platform" ? "Platform" : "Mark8ly"}
                </Badge>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TemplateStatus)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  disabled={isSystem}
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <Badge variant={statusVariant(status)}>{status}</Badge>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Type</CardTitle>
              </CardHeader>
              <CardContent>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  disabled={isSystem}
                >
                  <option value="transactional">Transactional</option>
                  <option value="marketing">Marketing</option>
                  <option value="notification">Notification</option>
                  <option value="system">System</option>
                </select>
              </CardContent>
            </Card>

            {!isNew && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Test Send</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Input
                    type="email"
                    value={testRecipient}
                    onChange={(e) => setTestRecipient(e.target.value)}
                    placeholder="test@example.com"
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleTestSend}
                    disabled={sending || !testRecipient}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    {sending ? "Sending..." : "Send Test"}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Variables reference in sidebar */}
            {categoryConfig && <VariablesPanel category={categoryConfig} />}
          </div>
        </div>
      </main>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Template"
        description="Are you sure you want to delete this template? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
        loading={deleting}
      />

      <TemplatePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        template={{
          id: templateId,
          name,
          slug: '',
          subject,
          type,
          category,
          status,
          html_body: htmlBody,
          variables,
        }}
      />
    </>
  );
}
