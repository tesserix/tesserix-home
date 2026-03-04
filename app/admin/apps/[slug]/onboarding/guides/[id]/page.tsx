"use client";

import { useState, use, useCallback } from "react";
import { ArrowLeft, Plus, Trash2, GripVertical, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import {
  useToast,
  Button,
  Input,
  Label,
  Textarea,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  ErrorState,
  ConfirmDialog,
} from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import {
  useOnboardingItem,
  updateOnboardingItem,
  createGuideStep,
  updateGuideStep,
  deleteGuideStep,
  type Guide,
  type GuideStep,
} from "@/lib/api/onboarding-content";

export default function GuideDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useOnboardingItem("guides", id);
  const guide = data?.data as Guide | undefined;

  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<Guide> | null>(null);
  const [deleteStepTarget, setDeleteStepTarget] = useState<string | null>(null);
  const [deleteStepLoading, setDeleteStepLoading] = useState(false);

  const form = formData ?? guide;

  const updateField = useCallback(
    (field: string, value: unknown) => {
      setFormData((prev) => ({ ...(prev ?? guide), [field]: value } as Partial<Guide>));
    },
    [guide]
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      const { title, slug: guideSlug, description, iconName, duration, featured, content, sortOrder, active } = form;
      const { error: err } = await updateOnboardingItem("guides", id, {
        title, slug: guideSlug, description, iconName, duration, featured, content, sortOrder, active,
      });
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      toast({ title: "Guide updated successfully", variant: "success" });
      mutate();
    } finally {
      setSaving(false);
    }
  }, [form, id, mutate]);

  // Step management
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [newStepTitle, setNewStepTitle] = useState("");

  const addStep = useCallback(async () => {
    if (!newStepTitle.trim()) return;
    const maxOrder = guide?.steps?.reduce((max, s) => Math.max(max, s.sortOrder), -1) ?? -1;
    const { error: err } = await createGuideStep(id, {
      title: newStepTitle.trim(),
      sortOrder: maxOrder + 1,
    });
    if (err) { toast({ title: "Failed to add step", variant: "destructive" }); return; }
    toast({ title: "Step added", variant: "success" });
    setNewStepTitle("");
    mutate();
  }, [newStepTitle, id, guide, mutate]);

  const handleUpdateStep = useCallback(
    async (stepId: string, data: Partial<GuideStep>) => {
      const { error: err } = await updateGuideStep(id, stepId, data);
      if (err) { toast({ title: "Failed to update step", variant: "destructive" }); return; }
      toast({ title: "Step updated", variant: "success" });
      mutate();
    },
    [id, mutate]
  );

  const handleDeleteStep = useCallback(
    (stepId: string) => {
      setDeleteStepTarget(stepId);
    },
    []
  );

  const confirmDeleteStep = useCallback(
    async () => {
      if (!deleteStepTarget) return;
      setDeleteStepLoading(true);
      const { error: err } = await deleteGuideStep(id, deleteStepTarget);
      setDeleteStepLoading(false);
      if (err) { toast({ title: "Failed to delete step", variant: "destructive" }); setDeleteStepTarget(null); return; }
      toast({ title: "Step deleted", variant: "success" });
      setDeleteStepTarget(null);
      mutate();
    },
    [id, deleteStepTarget, mutate]
  );

  if (isLoading) {
    return (
      <>
        <AdminHeader title="Guide" />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (error || !guide) {
    return (
      <>
        <AdminHeader title="Guide" />
        <main className="p-6">
          <ErrorState message={error || "Guide not found"} onRetry={mutate} />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader title={guide.title} description="Edit guide details and steps" />

      <main className="p-6 space-y-6">
        <Link
          href={`/admin/apps/${slug}/onboarding`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Onboarding
        </Link>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Guide Details */}
          <Card>
            <CardHeader>
              <CardTitle>Guide Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input value={form?.title || ""} onChange={(e) => updateField("title", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Slug</Label>
                  <Input value={form?.slug || ""} onChange={(e) => updateField("slug", e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={form?.description || ""} onChange={(e) => updateField("description", e.target.value)} rows={3} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Icon Name</Label>
                  <Input value={form?.iconName || ""} onChange={(e) => updateField("iconName", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Duration</Label>
                  <Input value={form?.duration || ""} onChange={(e) => updateField("duration", e.target.value)} placeholder="10 min read" />
                </div>
                <div className="space-y-2">
                  <Label>Sort Order</Label>
                  <Input type="number" value={form?.sortOrder ?? 0} onChange={(e) => updateField("sortOrder", parseInt(e.target.value) || 0)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Content (Markdown)</Label>
                <Textarea value={form?.content || ""} onChange={(e) => updateField("content", e.target.value)} rows={8} className="font-mono text-sm" />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form?.featured || false} onChange={(e) => updateField("featured", e.target.checked)} className="rounded" />
                  Featured
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form?.active !== false} onChange={(e) => updateField("active", e.target.checked)} className="rounded" />
                  Active
                </label>
              </div>

              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </CardContent>
          </Card>

          {/* Guide Steps */}
          <Card>
            <CardHeader>
              <CardTitle>Steps ({guide.steps?.length || 0})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a step..."
                  value={newStepTitle}
                  onChange={(e) => setNewStepTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addStep()}
                />
                <Button onClick={addStep} size="icon" variant="outline">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {guide.steps?.length ? (
                <div className="space-y-2">
                  {guide.steps.map((step) => (
                    <div key={step.id} className="rounded-md border">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="flex-1 text-sm font-medium">{step.title}</span>
                        {step.duration && (
                          <span className="text-xs text-muted-foreground">{step.duration}</span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                        >
                          {expandedStep === step.id ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive shrink-0"
                          onClick={() => handleDeleteStep(step.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>

                      {expandedStep === step.id && (
                        <StepEditor step={step} onUpdate={handleUpdateStep} />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No steps added yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <ConfirmDialog
          open={!!deleteStepTarget}
          onOpenChange={(open) => { if (!open) setDeleteStepTarget(null); }}
          title="Delete Step"
          description="Are you sure you want to delete this step? This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={confirmDeleteStep}
          loading={deleteStepLoading}
        />
      </main>
    </>
  );
}

function StepEditor({
  step,
  onUpdate,
}: {
  step: GuideStep;
  onUpdate: (stepId: string, data: Partial<GuideStep>) => Promise<void>;
}) {
  const [title, setTitle] = useState(step.title);
  const [description, setDescription] = useState(step.description || "");
  const [content, setContent] = useState(step.content || "");
  const [duration, setDuration] = useState(step.duration || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onUpdate(step.id, { title, description, content, duration });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t px-3 py-3 space-y-3 bg-muted/30">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Duration</Label>
          <Input value={duration} onChange={(e) => setDuration(e.target.value)} className="h-8 text-sm" placeholder="5 min" />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Description</Label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Content</Label>
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} className="font-mono text-sm" />
      </div>
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save Step"}
      </Button>
    </div>
  );
}
