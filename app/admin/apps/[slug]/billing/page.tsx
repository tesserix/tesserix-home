"use client";

import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import {
  RefreshCw,
  Check,
  X,
  Zap,
  Crown,
  Rocket,
  Building2,
  ChevronRight,
  DollarSign,
  Users,
  Clock,
  AlertTriangle,
  TrendingUp,
  ShieldAlert,
  CalendarClock,
  Receipt,
  ExternalLink,
  Plus,
  Pencil,
  Trash2,
  Globe,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  usePlans,
  createPlan,
  updatePlan,
  deletePlan,
  syncPlansToStripe,
  useEnhancedStats,
  useExpiringTrials,
  useAdminInvoices,
  extendTrial,
  type SubscriptionPlan,
  type EnhancedStats,
  type ExpiringTrial,
  type SubscriptionInvoice,
} from "@/lib/api/subscriptions";
import {
  useToast,
  Button,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  ErrorState,
  Input,
  Label,
  Textarea,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Checkbox,
} from "@tesserix/web";
import {
  createOnboardingItem,
  deleteOnboardingItem,
  type PaymentPlan,
} from "@/lib/api/onboarding-content";
import { apiFetch } from "@/lib/api/use-api";
import {
  subscriptionToPaymentPlan,
  subscriptionFeatureTexts,
  calculateRegionalPrice,
  SUPPORTED_COUNTRIES,
} from "@/lib/utils/plan-mapping";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

function getPlanIcon(name: string) {
  switch (name) {
    case "free":
      return <Zap className="h-5 w-5" />;
    case "starter":
      return <Rocket className="h-5 w-5" />;
    case "professional":
      return <Crown className="h-5 w-5" />;
    case "enterprise":
      return <Building2 className="h-5 w-5" />;
    default:
      return <Zap className="h-5 w-5" />;
  }
}

function formatCents(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(0)}`;
}

function formatCentsFull(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatStorage(mb: number): string {
  if (mb === -1) return "Unlimited";
  if (mb >= 1024) return `${(mb / 1024).toFixed(0)}GB`;
  return `${mb}MB`;
}

function formatLimit(value: number): string {
  if (value === -1) return "Unlimited";
  return value.toLocaleString();
}

function formatMrr(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getDaysLeft(trialEnd?: string): number {
  if (!trialEnd) return 0;
  const end = new Date(trialEnd);
  const now = new Date();
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ---------- KPI Section ----------

function KpiCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4 rounded" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16" />
      </CardContent>
    </Card>
  );
}

function KpiCards({ stats }: { stats: EnhancedStats | null }) {
  if (!stats) return null;

  const kpis = [
    {
      title: "MRR",
      value: formatMrr(stats.mrr),
      icon: <DollarSign className="h-4 w-4 text-muted-foreground" />,
      isFormatted: true,
    },
    {
      title: "Active",
      value: stats.activeCount,
      icon: <Users className="h-4 w-4 text-muted-foreground" />,
    },
    {
      title: "Trialing",
      value: stats.trialingCount,
      icon: <Clock className="h-4 w-4 text-muted-foreground" />,
    },
    {
      title: "Expiring (7d)",
      value: stats.expiringTrials7d,
      icon: <AlertTriangle className="h-4 w-4 text-amber-500" />,
    },
    {
      title: "Suspended",
      value: stats.suspendedCount,
      icon: <ShieldAlert className="h-4 w-4 text-destructive" />,
    },
    {
      title: "Conversion",
      value: `${(stats.trialConversionRate ?? 0).toFixed(1)}%`,
      icon: <TrendingUp className="h-4 w-4 text-muted-foreground" />,
      isFormatted: true,
    },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
      {kpis.map((kpi) => (
        <Card key={kpi.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">{kpi.title}</CardTitle>
            {kpi.icon}
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-bold">
              {kpi.isFormatted ? kpi.value : Number(kpi.value).toLocaleString()}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------- Plan Form Dialog ----------

const AVAILABLE_FEATURES = [
  "basic_analytics",
  "advanced_analytics",
  "email_support",
  "priority_support",
  "api_access",
  "custom_domain",
  "dedicated_support",
  "sla",
];

interface PlanFormData {
  name: string;
  displayName: string;
  description: string;
  monthlyPriceDollars: string;
  yearlyPriceDollars: string;
  isFree: boolean;
  isActive: boolean;
  maxProducts: string;
  maxUsers: string;
  maxStorageMb: string;
  trialDays: string;
  sortOrder: string;
  features: Record<string, boolean>;
}

function getDefaultFormData(): PlanFormData {
  return {
    name: "",
    displayName: "",
    description: "",
    monthlyPriceDollars: "0",
    yearlyPriceDollars: "0",
    isFree: false,
    isActive: true,
    maxProducts: "100",
    maxUsers: "2",
    maxStorageMb: "500",
    trialDays: "0",
    sortOrder: "0",
    features: {},
  };
}

function planToFormData(plan: SubscriptionPlan): PlanFormData {
  return {
    name: plan.name,
    displayName: plan.displayName,
    description: plan.description || "",
    monthlyPriceDollars: (plan.monthlyPriceCents / 100).toFixed(2),
    yearlyPriceDollars: (plan.yearlyPriceCents / 100).toFixed(2),
    isFree: plan.isFree,
    isActive: plan.isActive,
    maxProducts: String(plan.maxProducts),
    maxUsers: String(plan.maxUsers),
    maxStorageMb: String(plan.maxStorageMb),
    trialDays: String(plan.trialDays),
    sortOrder: String(plan.sortOrder),
    features: plan.features || {},
  };
}

function PlanFormDialog({
  plan,
  open,
  onOpenChange,
  onSuccess,
}: {
  plan: SubscriptionPlan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const isEditing = !!plan;
  const [form, setForm] = useState<PlanFormData>(getDefaultFormData());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens or plan changes
  useEffect(() => {
    if (open) {
      setForm(plan ? planToFormData(plan) : getDefaultFormData());
      setError(null);
    }
  }, [open, plan]);

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  function updateField<K extends keyof PlanFormData>(key: K, value: PlanFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleFeature(feature: string) {
    setForm((prev) => ({
      ...prev,
      features: { ...prev.features, [feature]: !prev.features[feature] },
    }));
  }

  async function handleSubmit() {
    if (!form.displayName.trim()) {
      setError("Display name is required");
      return;
    }
    const name = isEditing ? form.name : slugify(form.displayName);
    if (!name) {
      setError("Name could not be generated from display name");
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload: Partial<SubscriptionPlan> = {
      name,
      displayName: form.displayName.trim(),
      description: form.description.trim(),
      monthlyPriceCents: Math.round(parseFloat(form.monthlyPriceDollars || "0") * 100),
      yearlyPriceCents: Math.round(parseFloat(form.yearlyPriceDollars || "0") * 100),
      isFree: form.isFree,
      isActive: form.isActive,
      maxProducts: parseInt(form.maxProducts) || 0,
      maxUsers: parseInt(form.maxUsers) || 0,
      maxStorageMb: parseInt(form.maxStorageMb) || 0,
      trialDays: parseInt(form.trialDays) || 0,
      sortOrder: parseInt(form.sortOrder) || 0,
      features: Object.fromEntries(
        Object.entries(form.features).filter(([, v]) => v)
      ),
    };

    const result = isEditing
      ? await updatePlan(plan!.id, payload)
      : await createPlan(payload);

    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    } else {
      onOpenChange(false);
      onSuccess();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Plan" : "Create Plan"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Update the ${plan!.displayName} plan configuration.`
              : "Add a new subscription plan."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Row: Display Name + Sort Order */}
          <div className="grid gap-4 sm:grid-cols-[1fr_100px]">
            <div className="space-y-2">
              <Label htmlFor="plan-display-name">Display Name</Label>
              <Input
                id="plan-display-name"
                placeholder="e.g. Professional"
                value={form.displayName}
                onChange={(e) => updateField("displayName", e.target.value)}
              />
              {!isEditing && form.displayName && (
                <p className="text-xs text-muted-foreground">
                  Slug: <code>{slugify(form.displayName)}</code>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-sort-order">Order</Label>
              <Input
                id="plan-sort-order"
                type="number"
                min={0}
                value={form.sortOrder}
                onChange={(e) => updateField("sortOrder", e.target.value)}
              />
            </div>
          </div>

          {/* Description / Tagline */}
          <div className="space-y-2">
            <Label htmlFor="plan-description">Tagline</Label>
            <Textarea
              id="plan-description"
              placeholder="e.g. Everything you need to get started"
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              className="min-h-[60px]"
            />
            <p className="text-xs text-muted-foreground">
              Shown as subtitle on the pricing page when synced.
            </p>
          </div>

          {/* Pricing */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="plan-monthly">Monthly Price ($)</Label>
              <Input
                id="plan-monthly"
                type="number"
                min={0}
                step={0.01}
                value={form.monthlyPriceDollars}
                onChange={(e) => updateField("monthlyPriceDollars", e.target.value)}
                disabled={form.isFree}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-yearly">Yearly Price ($)</Label>
              <Input
                id="plan-yearly"
                type="number"
                min={0}
                step={0.01}
                value={form.yearlyPriceDollars}
                onChange={(e) => updateField("yearlyPriceDollars", e.target.value)}
                disabled={form.isFree}
              />
            </div>
          </div>

          {/* Limits */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="plan-products">Max Products</Label>
              <Input
                id="plan-products"
                type="number"
                value={form.maxProducts}
                onChange={(e) => updateField("maxProducts", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">-1 = unlimited</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-users">Max Users</Label>
              <Input
                id="plan-users"
                type="number"
                value={form.maxUsers}
                onChange={(e) => updateField("maxUsers", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">-1 = unlimited</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-storage">Storage (MB)</Label>
              <Input
                id="plan-storage"
                type="number"
                value={form.maxStorageMb}
                onChange={(e) => updateField("maxStorageMb", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">-1 = unlimited</p>
            </div>
          </div>

          {/* Trial + Toggles */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="plan-trial">Trial Days</Label>
              <Input
                id="plan-trial"
                type="number"
                min={0}
                value={form.trialDays}
                onChange={(e) => updateField("trialDays", e.target.value)}
              />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Checkbox
                id="plan-free"
                checked={form.isFree}
                onChange={(e) => {
                  updateField("isFree", e.target.checked);
                  if (e.target.checked) {
                    updateField("monthlyPriceDollars", "0");
                    updateField("yearlyPriceDollars", "0");
                  }
                }}
              />
              <Label htmlFor="plan-free" className="cursor-pointer">Free plan</Label>
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Checkbox
                id="plan-active"
                checked={form.isActive}
                onChange={(e) => updateField("isActive", e.target.checked)}
              />
              <Label htmlFor="plan-active" className="cursor-pointer">Active</Label>
            </div>
          </div>

          {/* Features */}
          <div className="space-y-2">
            <Label>Features</Label>
            <div className="grid grid-cols-2 gap-2">
              {AVAILABLE_FEATURES.map((feature) => (
                <label
                  key={feature}
                  className="flex items-center gap-2 text-sm cursor-pointer rounded-md border px-3 py-2 hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    checked={!!form.features[feature]}
                    onChange={() => toggleFeature(feature)}
                  />
                  <span>{feature.replace(/_/g, " ")}</span>
                </label>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving..." : isEditing ? "Save Changes" : "Create Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Extend Trial Dialog ----------

function ExtendTrialDialog({
  trial,
  open,
  onOpenChange,
  onSuccess,
}: {
  trial: ExpiringTrial | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [days, setDays] = useState<number>(14);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!trial) return;
    if (days < 1 || days > 365) {
      setError("Days must be between 1 and 365");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    const result = await extendTrial(trial.tenantId, days, reason.trim());

    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    } else {
      setDays(14);
      setReason("");
      onOpenChange(false);
      onSuccess();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend Trial</DialogTitle>
          <DialogDescription>
            Extend the trial period for tenant {trial?.tenantId?.slice(0, 8)}...
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="extend-days">Additional Days</Label>
            <Input
              id="extend-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value) || 0)}
            />
            <p className="text-xs text-muted-foreground">
              Enter a value between 1 and 365 days.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="extend-reason">Reason</Label>
            <Textarea
              id="extend-reason"
              placeholder="Why is this trial being extended?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-[80px]"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Extending..." : "Extend Trial"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Delete Plan Dialog ----------

function DeletePlanDialog({
  plan,
  open,
  onOpenChange,
  onSuccess,
}: {
  plan: SubscriptionPlan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (!plan) return;

    setSubmitting(true);
    setError(null);

    const result = await deletePlan(plan.id);

    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    } else {
      onOpenChange(false);
      onSuccess();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Plan</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{plan?.displayName}</strong>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {plan?.stripeProductId && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  This plan has a linked Stripe product. Deleting the plan will not remove the Stripe product — it will become orphaned.
                </p>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
            {submitting ? "Deleting..." : "Delete Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Plan Card ----------

function PlanCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-20" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </CardContent>
    </Card>
  );
}

function PlanCard({
  plan,
  onEdit,
  onDelete,
}: {
  plan: SubscriptionPlan;
  onEdit: (plan: SubscriptionPlan) => void;
  onDelete: (plan: SubscriptionPlan) => void;
}) {
  const features = plan.features || {};
  const featureList = Object.entries(features).filter(([, v]) => v);
  const isStripeSynced = !!plan.stripeProductId;

  return (
    <Card className={`relative group ${!plan.isActive ? "opacity-60" : ""}`}>
      {/* Edit + Delete buttons */}
      <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onEdit(plan)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-destructive"
          onClick={() => onDelete(plan)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <CardContent className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {getPlanIcon(plan.name)}
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold leading-tight">{plan.displayName}</h3>
            <p className="text-xs text-muted-foreground truncate">{plan.description}</p>
          </div>
        </div>

        {/* Price */}
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold">{formatCents(plan.monthlyPriceCents)}</span>
            {!plan.isFree && <span className="text-sm text-muted-foreground">/mo</span>}
          </div>
          {!plan.isFree && plan.yearlyPriceCents > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatCents(plan.yearlyPriceCents)}/yr
              {plan.monthlyPriceCents > 0 && (
                <> (save {Math.round((1 - plan.yearlyPriceCents / (plan.monthlyPriceCents * 12)) * 100)}%)</>
              )}
            </p>
          )}
        </div>

        {/* Limits */}
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Products</span>
            <span className="font-medium">{formatLimit(plan.maxProducts)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Users</span>
            <span className="font-medium">{formatLimit(plan.maxUsers)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Storage</span>
            <span className="font-medium">{formatStorage(plan.maxStorageMb)}</span>
          </div>
          {plan.trialDays > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Trial</span>
              <span className="font-medium">{plan.trialDays} days</span>
            </div>
          )}
        </div>

        {/* Features */}
        {featureList.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            {featureList.map(([feature]) => (
              <div key={feature} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="h-3 w-3 text-green-500 shrink-0" />
                <span>{feature.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        )}

        {/* Footer badges */}
        <div className="flex items-center gap-2 border-t pt-3">
          {plan.isFree && <Badge variant="secondary" className="text-xs">Free</Badge>}
          {plan.isActive ? (
            <Badge variant="success" className="text-xs">Active</Badge>
          ) : (
            <Badge variant="destructive" className="text-xs">Inactive</Badge>
          )}
          {isStripeSynced ? (
            <Badge variant="secondary" className="text-xs">
              <Check className="mr-1 h-3 w-3" />Stripe
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              <X className="mr-1 h-3 w-3" />Stripe
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Recent Payments ----------

const INVOICE_STATUSES = [
  { label: "All", value: "" },
  { label: "Paid", value: "paid" },
  { label: "Open", value: "open" },
  { label: "Void", value: "void" },
  { label: "Draft", value: "draft" },
];

function invoiceStatusVariant(status: string): "success" | "warning" | "secondary" {
  switch (status) {
    case "paid":
      return "success";
    case "open":
      return "warning";
    default:
      return "secondary";
  }
}

function RecentPaymentsSection() {
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const { data, isLoading, error, mutate } = useAdminInvoices(
    statusFilter || undefined,
    PAGE_SIZE,
    page * PAGE_SIZE,
  );

  function handleStatusChange(value: string) {
    setStatusFilter(value);
    setPage(0);
  }

  const invoices = data?.invoices ?? [];
  const total = data?.total ?? 0;
  const rangeStart = total > 0 ? page * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const hasNext = (page + 1) * PAGE_SIZE < total;
  const hasPrev = page > 0;

  if (error) {
    return <ErrorState message={error} onRetry={mutate} />;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent Payments</CardTitle>
          </div>
          <div className="flex gap-1">
            {INVOICE_STATUSES.map((s) => (
              <Button
                key={s.value}
                variant={statusFilter === s.value ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => handleStatusChange(s.value)}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No invoices found.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Date</TableHead>
                  <TableHead className="text-xs">Tenant</TableHead>
                  <TableHead className="text-xs">Amount</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">Links</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv: SubscriptionInvoice) => (
                  <TableRow key={inv.id}>
                    <TableCell className="text-xs py-2">{formatDate(inv.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs py-2">
                      {inv.tenantId.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="text-xs py-2 font-medium">{formatCentsFull(inv.amountDueCents)}</TableCell>
                    <TableCell className="py-2">
                      <Badge variant={invoiceStatusVariant(inv.status)} className="text-xs">
                        {inv.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right py-2">
                      <div className="flex items-center justify-end gap-1">
                        {inv.stripeHostedUrl && (
                          <a
                            href={inv.stripeHostedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                          >
                            View<ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {inv.stripeInvoicePdf && (
                          <a
                            href={inv.stripeInvoicePdf}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline inline-flex items-center gap-0.5 ml-2"
                          >
                            PDF<ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t">
              <span className="text-muted-foreground">
                {rangeStart}-{rangeEnd} of {total}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={!hasPrev}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasNext}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Expiring Trials ----------

function ExpiringTrialsSection() {
  const { data: trials, isLoading, error, mutate } = useExpiringTrials(30);
  const [selectedTrial, setSelectedTrial] = useState<ExpiringTrial | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleExtendClick(trial: ExpiringTrial) {
    setSelectedTrial(trial);
    setDialogOpen(true);
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={mutate} />;
  }

  const sorted = trials
    ? [...trials].sort((a, b) => {
        const aEnd = a.trialEnd ? new Date(a.trialEnd).getTime() : Infinity;
        const bEnd = b.trialEnd ? new Date(b.trialEnd).getTime() : Infinity;
        return aEnd - bEnd;
      })
    : [];

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">Expiring Trials</CardTitle>
            {sorted.length > 0 && (
              <Badge variant="warning" className="text-xs ml-1">{sorted.length}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No trials expiring in the next 30 days.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Tenant</TableHead>
                  <TableHead className="text-xs">Plan</TableHead>
                  <TableHead className="text-xs">Expires</TableHead>
                  <TableHead className="text-xs text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((trial) => {
                  const daysLeft = getDaysLeft(trial.trialEnd);
                  return (
                    <TableRow key={trial.id}>
                      <TableCell className="font-mono text-xs py-2">
                        {trial.tenantId.slice(0, 8)}...
                      </TableCell>
                      <TableCell className="text-xs py-2">
                        {trial.plan?.displayName || trial.planId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant={daysLeft <= 3 ? "destructive" : daysLeft <= 7 ? "warning" : "secondary"}
                          className="text-xs"
                        >
                          {daysLeft}d
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleExtendClick(trial)}
                        >
                          Extend
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ExtendTrialDialog
        trial={selectedTrial}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={() => mutate()}
      />
    </>
  );
}

// ---------- Main Page ----------

export default function AppBillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const { toast } = useToast();
  const { data: plans, isLoading, error, mutate } = usePlans();
  const { data: enhancedStats, isLoading: statsLoading } = useEnhancedStats();
  const [syncing, setSyncing] = useState(false);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingPlan, setDeletingPlan] = useState<SubscriptionPlan | null>(null);
  const [syncingPricing, setSyncingPricing] = useState(false);

  async function handleSyncToStripe() {
    setSyncing(true);
    const result = await syncPlansToStripe();
    setSyncing(false);
    if (!result.error) {
      mutate();
    }
  }

  async function handleSyncToPricingPage() {
    if (!plans || plans.length === 0) return;
    setSyncingPricing(true);
    try {
      // Fetch existing payment plans
      const { data: existing } = await apiFetch<{ data: PaymentPlan[] }>("/api/onboarding-content/payment-plans");
      const existingPlans = existing?.data ?? [];

      // Delete all existing payment plans (cascades to features + regional pricing)
      for (const pp of existingPlans) {
        await deleteOnboardingItem("payment-plans", pp.id);
      }

      // Create new payment plans from active subscription plans
      const activePlans = plans.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
      let created = 0;

      // Auto-determine featured plan (highest-priced non-enterprise plan, or middle plan)
      const paidPlans = activePlans.filter((p) => !p.isFree && p.monthlyPriceCents > 0);
      const featuredPlan = paidPlans.length > 0
        ? paidPlans.reduce((best, p) => p.monthlyPriceCents > best.monthlyPriceCents ? p : best)
        : null;

      for (const sub of activePlans) {
        const mapped = {
          ...subscriptionToPaymentPlan(sub),
          featured: featuredPlan?.id === sub.id,
        };
        const { data: result, error: createErr } = await createOnboardingItem("payment-plans", mapped);
        if (createErr || !result) continue;

        const newPlanId = (result as { data: PaymentPlan }).data?.id;
        if (!newPlanId) continue;

        // Create features
        const featureTexts = subscriptionFeatureTexts(sub);
        for (let i = 0; i < featureTexts.length; i++) {
          await apiFetch(`/api/onboarding-content/payment-plans/${newPlanId}/features`, {
            method: "POST",
            body: JSON.stringify({ feature: featureTexts[i], sortOrder: i }),
          });
        }

        // Create regional pricing for non-AUD countries
        for (const country of SUPPORTED_COUNTRIES) {
          if (country.currency === "AUD") continue;
          const baseAud = sub.monthlyPriceCents / 100;
          const regionalPrice = calculateRegionalPrice(baseAud, country.currency);
          if (regionalPrice > 0) {
            await apiFetch(`/api/onboarding-content/payment-plans/${newPlanId}/regional-pricing`, {
              method: "POST",
              body: JSON.stringify({
                countryCode: country.code,
                price: regionalPrice.toFixed(2),
                currency: country.currency,
              }),
            });
          }
        }

        created++;
      }

      toast({ title: `Synced ${created} plans to the pricing page`, variant: "success" });
    } catch {
      toast({ title: "Failed to sync plans to pricing page", variant: "destructive" });
    } finally {
      setSyncingPricing(false);
    }
  }

  function handleCreatePlan() {
    setEditingPlan(null);
    setPlanDialogOpen(true);
  }

  function handleEditPlan(plan: SubscriptionPlan) {
    setEditingPlan(plan);
    setPlanDialogOpen(true);
  }

  function handleDeletePlan(plan: SubscriptionPlan) {
    setDeletingPlan(plan);
    setDeleteDialogOpen(true);
  }

  function handlePlanSuccess() {
    mutate();
  }

  const sortedPlans = plans
    ? [...plans].filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  return (
    <>
      <AdminHeader
        title="Billing & Plans"
        description={`Manage subscriptions and billing for ${appName}`}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Billing</span>
        </nav>

        {/* KPI Row */}
        {statsLoading ? (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <KpiCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <KpiCards stats={enhancedStats} />
        )}

        {/* Plans Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Subscription Plans</h2>
              <p className="text-sm text-muted-foreground">
                {plans ? `${sortedPlans.length} active plans` : "Loading plans..."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleSyncToPricingPage}
                disabled={syncingPricing || !plans?.length}
                variant="outline"
                size="sm"
              >
                <Globe className={`mr-1.5 h-3.5 w-3.5 ${syncingPricing ? "animate-spin" : ""}`} />
                {syncingPricing ? "Syncing..." : "Sync to Pricing Page"}
              </Button>
              <Button
                onClick={handleSyncToStripe}
                disabled={syncing}
                variant="outline"
                size="sm"
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Sync to Stripe"}
              </Button>
              <Button onClick={handleCreatePlan} size="sm">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create Plan
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <PlanCardSkeleton key={i} />
              ))}
            </div>
          ) : error ? (
            <ErrorState message={error} onRetry={mutate} />
          ) : sortedPlans.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">No subscription plans configured yet.</p>
                <Button onClick={handleCreatePlan} variant="outline" className="mt-3">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Your First Plan
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {sortedPlans.map((plan) => (
                <PlanCard key={plan.id} plan={plan} onEdit={handleEditPlan} onDelete={handleDeletePlan} />
              ))}
            </div>
          )}
        </section>

        {/* Activity Section: Payments + Trials side by side */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Activity</h2>
          <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
            <RecentPaymentsSection />
            <ExpiringTrialsSection />
          </div>
        </section>
      </main>

      {/* Plan Create/Edit Dialog */}
      <PlanFormDialog
        plan={editingPlan}
        open={planDialogOpen}
        onOpenChange={setPlanDialogOpen}
        onSuccess={handlePlanSuccess}
      />

      {/* Delete Plan Dialog */}
      <DeletePlanDialog
        plan={deletingPlan}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onSuccess={handlePlanSuccess}
      />
    </>
  );
}
