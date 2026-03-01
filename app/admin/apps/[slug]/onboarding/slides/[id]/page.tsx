"use client";

import { useState, use, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useToast } from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import {
  useOnboardingItem,
  updateOnboardingItem,
  type PresentationSlide,
} from "@/lib/api/onboarding-content";

const SLIDE_TYPES = [
  "title",
  "problem",
  "solution",
  "features",
  "pricing",
  "testimonials",
  "cta",
  "stats",
  "comparison",
  "content",
];

export default function SlideDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useOnboardingItem("presentation-slides", id);
  const slide = data?.data as PresentationSlide | undefined;

  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<PresentationSlide> | null>(null);

  const form = formData ?? slide;

  const updateField = useCallback(
    (field: string, value: unknown) => {
      setFormData((prev) => ({ ...(prev ?? slide), [field]: value } as Partial<PresentationSlide>));
    },
    [slide]
  );

  // Content is JSONB — edit as pretty-printed JSON string
  const [contentJson, setContentJson] = useState<string | null>(null);
  const contentStr = contentJson ?? (form?.content != null ? JSON.stringify(form.content, null, 2) : "");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleContentChange = (val: string) => {
    setContentJson(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch {
      setJsonError("Invalid JSON");
    }
  };

  const handleSave = useCallback(async () => {
    if (!form) return;
    if (jsonError) {
      toast({ title: "Fix JSON errors before saving.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      let parsedContent = form.content;
      if (contentJson !== null) {
        try {
          parsedContent = JSON.parse(contentJson);
        } catch {
          toast({ title: "Invalid JSON in content field", variant: "destructive" });
          return;
        }
      }

      const { slideNumber, type, label, title, titleGradient, titleHighlight, subtitle, active } = form;
      const { error: err } = await updateOnboardingItem("presentation-slides", id, {
        slideNumber, type, label, title, titleGradient, titleHighlight, subtitle, content: parsedContent, active,
      });
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      toast({ title: "Slide updated successfully", variant: "success" });
      setContentJson(null);
      mutate();
    } finally {
      setSaving(false);
    }
  }, [form, contentJson, jsonError, id, mutate]);

  if (isLoading) {
    return (
      <>
        <AdminHeader title="Slide" />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (error || !slide) {
    return (
      <>
        <AdminHeader title="Slide" />
        <main className="p-6">
          <ErrorState message={error || "Slide not found"} onRetry={mutate} />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        title={`Slide ${slide.slideNumber}: ${slide.title || "(untitled)"}`}
        description="Edit presentation slide content"
      />

      <main className="p-6 space-y-6">
        <Link
          href={`/admin/apps/${slug}/onboarding`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Onboarding
        </Link>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Slide Metadata */}
          <Card>
            <CardHeader>
              <CardTitle>Slide Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Slide Number</Label>
                  <Input type="number" value={form?.slideNumber ?? 1} onChange={(e) => updateField("slideNumber", parseInt(e.target.value) || 1)} />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={form?.type || "content"} onValueChange={(v) => updateField("type", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SLIDE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Label</Label>
                <Input value={form?.label || ""} onChange={(e) => updateField("label", e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={form?.title || ""} onChange={(e) => updateField("title", e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Title Gradient</Label>
                  <Input value={form?.titleGradient || ""} onChange={(e) => updateField("titleGradient", e.target.value)} placeholder="Optional gradient text" />
                </div>
                <div className="space-y-2">
                  <Label>Title Highlight</Label>
                  <Input value={form?.titleHighlight || ""} onChange={(e) => updateField("titleHighlight", e.target.value)} placeholder="Optional highlight text" />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Subtitle</Label>
                <Textarea value={form?.subtitle || ""} onChange={(e) => updateField("subtitle", e.target.value)} rows={2} />
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form?.active !== false} onChange={(e) => updateField("active", e.target.checked)} className="rounded" />
                Active
              </label>
            </CardContent>
          </Card>

          {/* Slide Content (JSONB) */}
          <Card>
            <CardHeader>
              <CardTitle>Content (JSON)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Flexible JSON data for slide content. Structure depends on slide type (items, stats, features, etc.).
              </p>
              <Textarea
                value={contentStr}
                onChange={(e) => handleContentChange(e.target.value)}
                rows={20}
                className="font-mono text-sm"
              />
              {jsonError && (
                <p className="text-sm text-destructive">{jsonError}</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || !!jsonError}>
            {saving ? "Saving..." : "Save All Changes"}
          </Button>
        </div>
      </main>
    </>
  );
}
