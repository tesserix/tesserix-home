"use client";

import { use } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Users,
  Ticket,
  FileText,
  CreditCard,
  ToggleLeft,
  Mail,
  ArrowRight,
  Building2,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatsCard } from "@/components/admin/stats-card";
import { ErrorState } from "@/components/admin/error-state";
import { useTenants, type Tenant } from "@/lib/api/tenants";
import { useTickets, type Ticket as TicketType } from "@/lib/api/tickets";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

const APP_DESCRIPTIONS: Record<string, string> = {
  mark8ly: "Multi-tenant e-commerce marketplace platform",
};

const APP_ICONS: Record<string, string> = {
  mark8ly: "/mark8ly-icon.png",
};

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "active":
    case "resolved":
      return "success";
    case "pending":
    case "in_progress":
    case "in-progress":
      return "warning";
    case "open":
      return "info";
    default:
      return "secondary";
  }
}

function getPriorityColor(priority: string) {
  switch (priority?.toLowerCase()) {
    case "high":
    case "critical":
    case "urgent":
      return "destructive";
    case "medium":
      return "warning";
    case "low":
      return "secondary";
    default:
      return "secondary";
  }
}

function StatsLoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RecentListSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function AppOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const appDescription = APP_DESCRIPTIONS[slug] || "";
  const appIcon = APP_ICONS[slug];

  const { data: tenantsData, isLoading: tenantsLoading, error: tenantsError, mutate: mutateTenants } = useTenants({ limit: 5 });
  const { data: ticketsData, isLoading: ticketsLoading, error: ticketsError, mutate: mutateTickets } = useTickets({ limit: 5 });
  const { data: openTicketsData } = useTickets({ status: "open", limit: 1 });

  const totalTenants = tenantsData?.total ?? 0;
  const openTickets = openTicketsData?.total ?? 0;
  const recentTenants = tenantsData?.data ?? [];
  const recentTickets = ticketsData?.data ?? [];

  const quickLinks = [
    { name: "Tenants", href: `/admin/apps/${slug}/tenants`, icon: Users, description: "Manage stores" },
    { name: "Tickets", href: `/admin/apps/${slug}/tickets`, icon: Ticket, description: "Support requests" },
    { name: "Content", href: `/admin/apps/${slug}/content`, icon: FileText, description: "Page management" },
    { name: "Billing", href: `/admin/apps/${slug}/billing`, icon: CreditCard, description: "Subscription plans" },
    { name: "Feature Flags", href: `/admin/apps/${slug}/feature-flags`, icon: ToggleLeft, description: "Flags & experiments" },
    { name: "Email Templates", href: `/admin/apps/${slug}/email-templates`, icon: Mail, description: "Notification templates" },
  ];

  return (
    <>
      <AdminHeader
        title={appName}
        description={appDescription}
        icon={appIcon ? (
          <Image
            src={appIcon}
            alt={appName}
            width={32}
            height={32}
            className="brightness-0 dark:invert"
          />
        ) : undefined}
      />

      <main className="p-6 space-y-6">
        {/* Stats */}
        {tenantsLoading || ticketsLoading ? (
          <StatsLoadingSkeleton />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatsCard
              title="Total Tenants"
              value={totalTenants}
              description="Active stores"
              icon={<Building2 className="h-4 w-4" />}
            />
            <StatsCard
              title="Open Tickets"
              value={openTickets}
              description="Requires attention"
              icon={<Ticket className="h-4 w-4" />}
            />
            <StatsCard
              title="Recent Activity"
              value={recentTenants.length + recentTickets.length}
              description="Latest events"
              icon={<Users className="h-4 w-4" />}
            />
          </div>
        )}

        {/* Quick Links */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Quick Links</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {quickLinks.map((link) => (
              <Link key={link.name} href={link.href}>
                <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                      <link.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{link.name}</p>
                      <p className="text-xs text-muted-foreground">{link.description}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent Tenants */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Stores</CardTitle>
                <CardDescription>Newly onboarded businesses</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/admin/apps/${slug}/tenants`}>
                  View all
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {tenantsLoading ? (
                <RecentListSkeleton />
              ) : tenantsError ? (
                <ErrorState message={tenantsError} onRetry={mutateTenants} />
              ) : recentTenants.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No stores yet</p>
              ) : (
                <div className="space-y-4">
                  {recentTenants.map((tenant: Tenant) => (
                    <div
                      key={tenant.id}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <Link
                          href={`/admin/apps/${slug}/${tenant.id}`}
                          className="font-medium hover:underline"
                        >
                          {tenant.name}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {tenant.slug}
                        </p>
                      </div>
                      {tenant.status && (
                        <Badge variant={getStatusColor(tenant.status)}>
                          {tenant.status}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Tickets */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Tickets</CardTitle>
                <CardDescription>Support requests from tenants</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/admin/apps/${slug}/tickets`}>
                  View all
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {ticketsLoading ? (
                <RecentListSkeleton />
              ) : ticketsError ? (
                <ErrorState message={ticketsError} onRetry={mutateTickets} />
              ) : recentTickets.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No tickets yet</p>
              ) : (
                <div className="space-y-4">
                  {recentTickets.map((ticket: TicketType) => (
                    <div
                      key={ticket.id}
                      className="flex items-center justify-between"
                    >
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/admin/apps/${slug}/tickets/${ticket.id}`}
                          className="font-medium hover:underline block truncate"
                        >
                          {ticket.title}
                        </Link>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant={getStatusColor(ticket.status)} className="text-xs">
                            {ticket.status?.toLowerCase().replace(/_/g, " ")}
                          </Badge>
                          <Badge variant={getPriorityColor(ticket.priority)} className="text-xs">
                            {ticket.priority?.toLowerCase()}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}
