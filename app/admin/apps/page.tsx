"use client";

import Link from "next/link";
import { ShoppingBag, Users, ArrowRight } from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTenants } from "@/lib/api/tenants";

const APPS = [
  {
    slug: "mark8ly",
    name: "Mark8ly",
    description: "Multi-tenant marketplace platform for e-commerce businesses",
    icon: ShoppingBag,
    status: "active" as const,
  },
];

export default function AppsPage() {
  const { data: tenantsData } = useTenants({ limit: 1 });
  const totalTenants = tenantsData?.total ?? 0;

  return (
    <>
      <AdminHeader
        title="Apps"
        description="Platform applications and their tenants"
      />

      <main className="p-6 space-y-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((app) => (
            <Link key={app.slug} href={`/admin/apps/${app.slug}`}>
              <Card className="hover:border-primary/50 hover:shadow-md transition-all cursor-pointer h-full">
                <CardHeader className="flex flex-row items-start gap-4 space-y-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                    <app.icon className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{app.name}</CardTitle>
                      <Badge variant="success">{app.status}</Badge>
                    </div>
                    <CardDescription className="mt-1">{app.description}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span>{totalTenants} {totalTenants === 1 ? "tenant" : "tenants"}</span>
                    </div>
                    <div className="flex items-center gap-1 text-sm text-primary font-medium">
                      View tenants
                      <ArrowRight className="h-4 w-4" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
