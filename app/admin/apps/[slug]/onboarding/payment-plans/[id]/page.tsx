"use client";

import { useState, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2, GripVertical, Star, RefreshCw, Info, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import {
  useToast,
  Button,
  Input,
  Label,
  Textarea,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  ErrorState,
  Checkbox,
} from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import {
  useOnboardingItem,
  updateOnboardingItem,
  useRegionalPricing,
  createRegionalPricing,
  deleteRegionalPricing,
  type PaymentPlan,
  type PlanFeature,
  type RegionalPricing,
} from "@/lib/api/onboarding-content";
import { apiFetch } from "@/lib/api/use-api";
import {
  usePlans,
  type SubscriptionPlan,
} from "@/lib/api/subscriptions";
import {
  subscriptionFeatureTexts,
  calculateRegionalPrice,
  SUPPORTED_COUNTRIES,
  EXCHANGE_RATES,
} from "@/lib/utils/plan-mapping";

const BASE_PATH = "/api/onboarding-content";

export default function PaymentPlanDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useOnboardingItem("payment-plans", id);
  const plan = data?.data as PaymentPlan | undefined;
  const { data: subPlans } = usePlans();
  const { data: regionalData, mutate: mutateRegional } = useRegionalPricing(id);
  const regionalPrices = (regionalData?.data ?? []) as RegionalPricing[];

  // Find linked subscription plan
  const linkedPlan = subPlans?.find((sp) => sp.name === plan?.slug) ?? null;

  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<PaymentPlan> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [generatingPrices, setGeneratingPrices] = useState(false);
  const [addingCountry, setAddingCountry] = useState(false);
  const [newCountryCode, setNewCountryCode] = useState("");
  const [newCountryPrice, setNewCountryPrice] = useState("");

  // Initialize form when data loads
  const form = formData ?? plan;

  const updateField = useCallback(
    (field: string, value: unknown) => {
      setFormData((prev) => ({ ...(prev ?? plan), [field]: value } as Partial<PaymentPlan>));
    },
    [plan]
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      const { name, slug: planSlug, price, currency, billingCycle, trialDays, description, tagline, featured, sortOrder, active } = form;
      const { error: err } = await updateOnboardingItem("payment-plans", id, {
        name, slug: planSlug, price, currency, billingCycle, trialDays, description, tagline, featured, sortOrder, active,
      });
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      toast({ title: "Plan updated successfully", variant: "success" });
      mutate();
    } finally {
      setSaving(false);
    }
  }, [form, id, mutate]);

  // Feature management
  const [newFeature, setNewFeature] = useState("");

  const addFeature = useCallback(async () => {
    if (!newFeature.trim()) return;
    const maxOrder = plan?.features?.reduce((max, f) => Math.max(max, f.sortOrder), -1) ?? -1;
    const { error: err } = await apiFetch(`${BASE_PATH}/payment-plans/${id}/features`, {
      method: "POST",
      body: JSON.stringify({ feature: newFeature.trim(), sortOrder: maxOrder + 1 }),
    });
    if (err) { toast({ title: "Failed to add feature", variant: "destructive" }); return; }
    toast({ title: "Feature added", variant: "success" });
    setNewFeature("");
    mutate();
  }, [newFeature, id, plan, mutate]);

  const removeFeature = useCallback(
    async (featureId: string) => {
      const { error: err } = await apiFetch(`${BASE_PATH}/payment-plans/${id}/features/${featureId}`, {
        method: "DELETE",
      });
      if (err) { toast({ title: "Failed to remove feature", variant: "destructive" }); return; }
      toast({ title: "Feature removed", variant: "success" });
      mutate();
    },
    [id, mutate]
  );

  const toggleHighlight = useCallback(
    async (feature: PlanFeature) => {
      await apiFetch(`${BASE_PATH}/payment-plans/${id}/features/${feature.id}`, {
        method: "PUT",
        body: JSON.stringify({ highlighted: !feature.highlighted }),
      });
      mutate();
    },
    [id, mutate]
  );

  // Sync features from linked billing plan
  const handleSyncFeatures = useCallback(async () => {
    if (!linkedPlan) return;
    setSyncing(true);
    try {
      const featureTexts = subscriptionFeatureTexts(linkedPlan);
      const existingFeatures = plan?.features?.map((f) => f.feature) ?? [];
      const newFeatures = featureTexts.filter((t) => !existingFeatures.includes(t));

      const maxOrder = plan?.features?.reduce((max, f) => Math.max(max, f.sortOrder), -1) ?? -1;
      for (let i = 0; i < newFeatures.length; i++) {
        await apiFetch(`${BASE_PATH}/payment-plans/${id}/features`, {
          method: "POST",
          body: JSON.stringify({ feature: newFeatures[i], sortOrder: maxOrder + 1 + i }),
        });
      }

      toast({ title: `Added ${newFeatures.length} new feature${newFeatures.length !== 1 ? "s" : ""}`, variant: "success" });
      mutate();
    } catch {
      toast({ title: "Failed to sync features", variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [linkedPlan, plan, id, mutate]);

  // Count features that would be synced
  const syncableFeatureCount = linkedPlan
    ? subscriptionFeatureTexts(linkedPlan).filter(
        (t) => !(plan?.features?.map((f) => f.feature) ?? []).includes(t)
      ).length
    : 0;

  // Auto-generate regional pricing
  const handleAutoGenerate = useCallback(async () => {
    if (!plan) return;
    setGeneratingPrices(true);
    try {
      const baseAud = parseFloat(plan.price) || 0;

      // Delete existing regional pricing
      for (const rp of regionalPrices) {
        await deleteRegionalPricing(id, rp.id);
      }

      // Create new ones for non-AUD countries
      for (const country of SUPPORTED_COUNTRIES) {
        if (country.currency === "AUD") continue;
        const price = calculateRegionalPrice(baseAud, country.currency);
        if (price > 0) {
          await createRegionalPricing(id, {
            countryCode: country.code,
            price: price.toFixed(2),
            currency: country.currency,
          });
        }
      }

      toast({ title: "Regional pricing generated", variant: "success" });
      mutateRegional();
    } catch {
      toast({ title: "Failed to generate regional pricing", variant: "destructive" });
    } finally {
      setGeneratingPrices(false);
    }
  }, [plan, id, regionalPrices, mutateRegional]);

  // Add single country pricing
  const handleAddCountry = useCallback(async () => {
    if (!newCountryCode || !newCountryPrice) return;
    setAddingCountry(true);
    try {
      const country = SUPPORTED_COUNTRIES.find((c) => c.code === newCountryCode);
      const currency = country?.currency || newCountryCode;
      const { error: err } = await createRegionalPricing(id, {
        countryCode: newCountryCode,
        price: parseFloat(newCountryPrice).toFixed(2),
        currency,
      });
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      toast({ title: "Regional price added", variant: "success" });
      setNewCountryCode("");
      setNewCountryPrice("");
      mutateRegional();
    } catch {
      toast({ title: "Failed to add regional price", variant: "destructive" });
    } finally {
      setAddingCountry(false);
    }
  }, [newCountryCode, newCountryPrice, id, mutateRegional]);

  // Remove regional pricing
  const handleRemoveRegional = useCallback(async (pricingId: string) => {
    const { error: err } = await deleteRegionalPricing(id, pricingId);
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    toast({ title: "Regional price removed", variant: "success" });
    mutateRegional();
  }, [id, mutateRegional]);

  if (isLoading) {
    return (
      <>
        <AdminHeader title="Payment Plan" />
        <main className="p-6 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (error || !plan) {
    return (
      <>
        <AdminHeader title="Payment Plan" />
        <main className="p-6">
          <ErrorState message={error || "Plan not found"} onRetry={mutate} />
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHeader title={plan.name} description="Edit payment plan details and features" />

      <main className="p-6 space-y-6">
        <Link
          href={`/admin/apps/${slug}/onboarding`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Onboarding
        </Link>

        {/* Linked billing plan banner */}
        {linkedPlan && (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-blue-800 dark:text-blue-200">
                <Info className="h-4 w-4 shrink-0" />
                <span>
                  Linked to billing plan: <strong>{linkedPlan.displayName}</strong>{" "}
                  ({linkedPlan.monthlyPriceCents === 0 ? "Free" : `$${(linkedPlan.monthlyPriceCents / 100).toFixed(0)}/mo`})
                </span>
              </div>
              <Link
                href={`/admin/apps/${slug}/billing`}
                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
              >
                View Billing
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Plan Details */}
          <Card>
            <CardHeader>
              <CardTitle>Plan Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={form?.name || ""} onChange={(e) => updateField("name", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Slug</Label>
                  <Input value={form?.slug || ""} onChange={(e) => updateField("slug", e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Price</Label>
                  <Input value={form?.price || ""} onChange={(e) => updateField("price", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input value={form?.currency || "INR"} onChange={(e) => updateField("currency", e.target.value)} maxLength={3} />
                </div>
                <div className="space-y-2">
                  <Label>Billing Cycle</Label>
                  <Select value={form?.billingCycle || "monthly"} onValueChange={(v) => updateField("billingCycle", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                      <SelectItem value="one_time">One Time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Trial Days</Label>
                  <Input type="number" value={form?.trialDays ?? 0} onChange={(e) => updateField("trialDays", parseInt(e.target.value) || 0)} />
                </div>
                <div className="space-y-2">
                  <Label>Sort Order</Label>
                  <Input type="number" value={form?.sortOrder ?? 0} onChange={(e) => updateField("sortOrder", parseInt(e.target.value) || 0)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Tagline</Label>
                <Input value={form?.tagline || ""} onChange={(e) => updateField("tagline", e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={form?.description || ""} onChange={(e) => updateField("description", e.target.value)} rows={3} />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form?.featured || false} onChange={(e) => updateField("featured", e.target.checked)} />
                  Featured
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form?.active !== false} onChange={(e) => updateField("active", e.target.checked)} />
                  Active
                </label>
              </div>

              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </CardContent>
          </Card>

          {/* Plan Features */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Plan Features ({plan.features?.length || 0})</CardTitle>
                {linkedPlan && syncableFeatureCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={handleSyncFeatures}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1.5 h-3 w-3" />
                    )}
                    Sync from Billing ({syncableFeatureCount})
                  </Button>
                )}
              </div>
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

              {plan.features?.length ? (
                <div className="space-y-2">
                  {plan.features.map((feature) => (
                    <div
                      key={feature.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2"
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="flex-1 text-sm">{feature.feature}</span>
                      {feature.highlighted && (
                        <Badge variant="warning" className="shrink-0">Highlighted</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => toggleHighlight(feature)}
                        title={feature.highlighted ? "Remove highlight" : "Highlight"}
                      >
                        <Star className={`h-3.5 w-3.5 ${feature.highlighted ? "fill-yellow-500 text-yellow-500" : ""}`} />
                      </Button>
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

        {/* Regional Pricing */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Regional Pricing</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={handleAutoGenerate}
                disabled={generatingPrices}
              >
                {generatingPrices ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3 w-3" />
                )}
                Auto-generate All
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {regionalPrices.length > 0 ? (
              <div className="rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Country</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Currency</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Price</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionalPrices.map((rp) => {
                      const country = SUPPORTED_COUNTRIES.find((c) => c.code === rp.countryCode);
                      const ex = EXCHANGE_RATES[rp.currency];
                      return (
                        <tr key={rp.id} className="border-b last:border-b-0">
                          <td className="px-4 py-2 font-medium">
                            {country?.name || rp.countryCode}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">{rp.currency}</td>
                          <td className="px-4 py-2">
                            {ex?.symbol || ""}{parseFloat(rp.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() => handleRemoveRegional(rp.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No regional pricing configured. Click &quot;Auto-generate All&quot; to calculate prices from the base AUD price.
              </p>
            )}

            {/* Add Country inline form */}
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Country</Label>
                <Select value={newCountryCode} onValueChange={(v) => {
                  setNewCountryCode(v);
                  // Auto-calculate price
                  const country = SUPPORTED_COUNTRIES.find((c) => c.code === v);
                  if (country && plan) {
                    const baseAud = parseFloat(plan.price) || 0;
                    const price = calculateRegionalPrice(baseAud, country.currency);
                    setNewCountryPrice(price > 0 ? price.toFixed(2) : "");
                  }
                }}>
                  <SelectTrigger className="w-[180px] h-8 text-xs">
                    <SelectValue placeholder="Select country" />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_COUNTRIES
                      .filter((c) => c.currency !== "AUD")
                      .filter((c) => !regionalPrices.some((rp) => rp.countryCode === c.code))
                      .map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.name} ({c.currency})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Price</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newCountryPrice}
                  onChange={(e) => setNewCountryPrice(e.target.value)}
                  className="w-[120px] h-8 text-xs"
                  placeholder="0.00"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={handleAddCountry}
                disabled={addingCountry || !newCountryCode || !newCountryPrice}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
