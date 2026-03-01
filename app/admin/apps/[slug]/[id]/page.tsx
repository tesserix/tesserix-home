"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Mail, Calendar, Building2, Globe, CreditCard, FileText, RefreshCw, ChevronRight } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTenant } from "@/lib/api/tenants";
import {
  useTenantSubscription,
  useTenantInvoices,
  cancelSubscription,
  reactivateSubscription,
  createPortalSession,
  type TenantSubscription,
  type SubscriptionInvoice,
} from "@/lib/api/subscriptions";

const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || "tesserix.app";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "active":
      return "success";
    case "pending":
      return "warning";
    case "suspended":
      return "destructive";
    default:
      return "secondary";
  }
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2"><Skeleton className="h-4 w-20" /></CardHeader>
            <CardContent><Skeleton className="h-8 w-16" /></CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function getSubscriptionStatusColor(status: string) {
  switch (status) {
    case "active":
      return "success";
    case "trialing":
      return "info";
    case "past_due":
      return "destructive";
    case "canceled":
      return "secondary";
    default:
      return "warning";
  }
}

function getInvoiceStatusColor(status: string) {
  switch (status) {
    case "paid":
      return "success";
    case "open":
      return "warning";
    case "void":
      return "secondary";
    default:
      return "default";
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function TenantBillingTab({ tenantId }: { tenantId: string }) {
  const { data: subscription, isLoading: subLoading, error: subError, mutate: mutateSub } = useTenantSubscription(tenantId);
  const { data: invoices, isLoading: invLoading } = useTenantInvoices(tenantId);
  const [actionLoading, setActionLoading] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  function handleCancel() {
    setCancelOpen(true);
  }

  async function confirmCancel() {
    setActionLoading(true);
    await cancelSubscription(tenantId);
    setActionLoading(false);
    setCancelOpen(false);
    mutateSub();
  }

  async function handleReactivate() {
    setActionLoading(true);
    await reactivateSubscription(tenantId);
    setActionLoading(false);
    mutateSub();
  }

  async function handleManageBilling() {
    setActionLoading(true);
    const result = await createPortalSession(tenantId);
    setActionLoading(false);
    if (result.data?.portal_url) {
      window.open(result.data.portal_url, "_blank");
    }
  }

  if (subLoading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader><Skeleton className="h-6 w-48" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (subError) {
    return <ErrorState message={subError} onRetry={mutateSub} />;
  }

  if (!subscription) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Subscription</CardTitle>
          <CardDescription>This tenant does not have an active subscription yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The tenant will be automatically assigned a subscription when they complete the Stripe checkout flow.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current Plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Current Plan
              </CardTitle>
              <CardDescription>Subscription and billing details</CardDescription>
            </div>
            <Badge variant={getSubscriptionStatusColor(subscription.status)}>
              {subscription.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Plan</p>
              <p className="text-lg font-semibold">{subscription.plan?.displayName || "Unknown"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Billing</p>
              <p className="text-lg font-semibold capitalize">{subscription.billingInterval}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Current Period</p>
              <p className="text-sm">
                {subscription.currentPeriodStart
                  ? new Date(subscription.currentPeriodStart).toLocaleDateString()
                  : "-"}{" "}
                &mdash;{" "}
                {subscription.currentPeriodEnd
                  ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                  : "-"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Next Billing</p>
              <p className="text-sm">
                {subscription.cancelAtPeriodEnd
                  ? "Cancels at period end"
                  : subscription.currentPeriodEnd
                    ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                    : "-"}
              </p>
            </div>
          </div>

          {subscription.cancelAtPeriodEnd && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200">
              This subscription is set to cancel at the end of the current billing period.
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handleManageBilling}
              disabled={actionLoading}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Manage in Stripe
            </Button>
            {subscription.cancelAtPeriodEnd ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReactivate}
                disabled={actionLoading}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Reactivate
              </Button>
            ) : subscription.status === "active" || subscription.status === "trialing" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={actionLoading}
                className="text-destructive hover:text-destructive"
              >
                Cancel Subscription
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Invoice History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Invoice History
          </CardTitle>
          <CardDescription>Recent invoices for this tenant</CardDescription>
        </CardHeader>
        <CardContent>
          {invLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !invoices || invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No invoices yet</p>
          ) : (
            <div className="rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Amount</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice: SubscriptionInvoice) => (
                    <tr key={invoice.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {invoice.createdAt
                          ? new Date(invoice.createdAt).toLocaleDateString()
                          : "-"}
                      </td>
                      <td className="px-4 py-2 font-medium">
                        {formatCents(invoice.amountDueCents)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={getInvoiceStatusColor(invoice.status)}>
                          {invoice.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {invoice.stripeHostedUrl && (
                            <a
                              href={invoice.stripeHostedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-xs"
                            >
                              View
                            </a>
                          )}
                          {invoice.stripeInvoicePdf && (
                            <a
                              href={invoice.stripeInvoicePdf}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-xs"
                            >
                              PDF
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel Subscription"
        description="Cancel this subscription? It will remain active until the end of the current billing period."
        confirmLabel="Cancel Subscription"
        variant="default"
        onConfirm={confirmCancel}
        loading={actionLoading}
      />
    </div>
  );
}

export default function AppTenantDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const { data: tenant, isLoading, error, mutate } = useTenant(id);

  const storeUrl = tenant?.custom_domain && tenant.use_custom_domain
    ? `https://${tenant.custom_domain}`
    : tenant?.slug
      ? `https://${tenant.slug}.${BASE_DOMAIN}`
      : null;

  return (
    <>
      <AdminHeader title="Tenant Details" />

      <main className="p-6 space-y-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/admin/apps" className="hover:text-foreground transition-colors">
            Apps
          </Link>
          <ChevronRight className="h-4 w-4" />
          <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
            {appName}
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">
            {tenant?.display_name || tenant?.name || "Details"}
          </span>
        </nav>

        {isLoading ? (
          <DetailSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={mutate} />
        ) : !tenant ? (
          <ErrorState message="Tenant not found" />
        ) : (
          <>
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="h-8 w-8" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">{tenant.display_name || tenant.name}</h2>
                  <p className="text-muted-foreground">{tenant.slug}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {tenant.status && (
                  <Badge variant={getStatusColor(tenant.status)} className="text-sm">
                    {tenant.status}
                  </Badge>
                )}
                {storeUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={storeUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Visit Store
                    </a>
                  </Button>
                )}
              </div>
            </div>

            {/* Tabs */}
            <Tabs defaultValue="overview" className="space-y-6">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="billing">Billing</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-6">
                {/* Details */}
                <Card>
                  <CardHeader>
                    <CardTitle>Tenant Information</CardTitle>
                    <CardDescription>Basic details about this tenant</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      {tenant.email && (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-muted-foreground">Email</p>
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            <a href={`mailto:${tenant.email}`} className="text-primary hover:underline">
                              {tenant.email}
                            </a>
                          </div>
                        </div>
                      )}
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">Created</p>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <span>
                            {tenant.created_at
                              ? new Date(tenant.created_at).toLocaleDateString()
                              : "-"}
                          </span>
                        </div>
                      </div>
                      {tenant.industry && (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-muted-foreground">Industry</p>
                          <Badge variant="secondary">{tenant.industry}</Badge>
                        </div>
                      )}
                      {tenant.custom_domain && (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-muted-foreground">Custom Domain</p>
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-muted-foreground" />
                            <a
                              href={`https://${tenant.custom_domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary hover:underline"
                            >
                              {tenant.custom_domain}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </div>
                      )}
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">Storefront URL</p>
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          {storeUrl ? (
                            <a
                              href={storeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary hover:underline"
                            >
                              {tenant.slug}.{BASE_DOMAIN}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </div>
                      </div>
                      {tenant.admin_url && (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-muted-foreground">Admin URL</p>
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-muted-foreground" />
                            <a
                              href={tenant.admin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary hover:underline"
                            >
                              {tenant.slug}-admin.{BASE_DOMAIN}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="settings">
                <Card>
                  <CardHeader>
                    <CardTitle>Tenant Settings</CardTitle>
                    <CardDescription>Configure tenant-specific settings</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">Settings management coming soon...</p>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="billing">
                <TenantBillingTab tenantId={id} />
              </TabsContent>

              <TabsContent value="activity">
                <Card>
                  <CardHeader>
                    <CardTitle>Recent Activity</CardTitle>
                    <CardDescription>Activity log for this tenant</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">Activity log coming soon...</p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </>
  );
}
