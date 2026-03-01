"use client";

import { useState, use, useCallback } from "react";
import { ArrowLeft, Plus, Trash2, GripVertical } from "lucide-react";
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
  type Integration,
  type IntegrationFeature,
} from "@/lib/api/onboarding-content";
import { apiFetch } from "@/lib/api/use-api";

const BASE_PATH = "/api/onboarding-content";

export default function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useOnboardingItem("integrations", id);
  const integration = data?.data as Integration | undefined;

  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<Integration> | null>(null);

  const form = formData ?? integration;

  const updateField = useCallback(
    (field: string, value: unknown) => {
      setFormData((prev) => ({ ...(prev ?? integration), [field]: value } as Partial<Integration>));
    },
    [integration]
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      const { name, category, description, logoUrl, status, sortOrder, active } = form;
      const { error: err } = await updateOnboardingItem("integrations", id, {
        name, category, description, logoUrl, status, sortOrder, active,
      });
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      toast({ title: "Integration updated successfully", variant: "success" });
      mutate();
    } finally {
      setSaving(false);
    }
  }, [form, id, mutate]);

  // Feature management
  const [newFeature, setNewFeature] = useState("");

  const addFeature = useCallback(async () => {
    if (!newFeature.trim()) return;
    const maxOrder = integration?.features?.reduce((max, f) => Math.max(max, f.sortOrder), -1) ?? -1;
    const { error: err } = await apiFetch(`${BASE_PATH}/integrations/${id}/features`, {
      method: "POST",
      body: JSON.stringify({ feature: newFeature.trim(), sortOrder: maxOrder + 1 }),
    });
    if (err) { toast({ title: "Failed to add feature", variant: "destructive" }); return; }
    toast({ title: "Feature added", variant: "success" });
    setNewFeature("");
    mutate();
  }, [newFeature, id, integration, mutate]);

  const removeFeature = useCallback(
    async (featureId: string) => {
      const { error: err } = await apiFetch(`${BASE_PATH}/integrations/${id}/features/${featureId}`, {
        method: "DELETE",
      });
      if (err) { toast({ title: "Failed to remove feature", variant: "destructive" }); return; }
      toast({ title: "Feature removed", variant: "success" });
      mutate();
    },
    [id, mutate]
  );

  if (isLoading) {
    return (
      <>
        <AdminHeader title="Integration" />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (error || !integration) {
    return (
      <>
        <AdminHeader title="Integration" />
        <main className="p-6">
          <ErrorState message={error || "Integration not found"} onRetry={mutate} />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader title={integration.name} description="Edit integration details and features" />

      <main className="p-6 space-y-6">
        <Link
          href={`/admin/apps/${slug}/onboarding`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Onboarding
        </Link>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Integration Details */}
          <Card>
            <CardHeader>
              <CardTitle>Integration Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={form?.name || ""} onChange={(e) => updateField("name", e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={form?.category || "other"} onValueChange={(v) => updateField("category", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="payments">Payments</SelectItem>
                      <SelectItem value="shipping">Shipping</SelectItem>
                      <SelectItem value="marketing">Marketing</SelectItem>
                      <SelectItem value="analytics">Analytics</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={form?.status || "active"} onValueChange={(v) => updateField("status", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="coming_soon">Coming Soon</SelectItem>
                      <SelectItem value="beta">Beta</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={form?.description || ""} onChange={(e) => updateField("description", e.target.value)} rows={3} />
              </div>

              <div className="space-y-2">
                <Label>Logo URL</Label>
                <Input value={form?.logoUrl || ""} onChange={(e) => updateField("logoUrl", e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Sort Order</Label>
                  <Input type="number" value={form?.sortOrder ?? 0} onChange={(e) => updateField("sortOrder", parseInt(e.target.value) || 0)} />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form?.active !== false} onChange={(e) => updateField("active", e.target.checked)} className="rounded" />
                    Active
                  </label>
                </div>
              </div>

              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </CardContent>
          </Card>

          {/* Integration Features */}
          <Card>
            <CardHeader>
              <CardTitle>Features ({integration.features?.length || 0})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a feature..."
                  value={newFeature}
                  onChange={(e) => setNewFeature(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addFeature()}
                />
                <Button onClick={addFeature} size="icon" variant="outline">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {integration.features?.length ? (
                <div className="space-y-2">
                  {integration.features.map((feature) => (
                    <div
                      key={feature.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2"
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="flex-1 text-sm">{feature.feature}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive shrink-0"
                        onClick={() => removeFeature(feature.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No features added yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}
