"use client";

import { useTenants, type Tenant } from "@/lib/api/tenants";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Store } from "lucide-react";

interface TenantSelectorProps {
  value: string | null;
  onSelect: (tenantId: string, tenantName: string) => void;
  className?: string;
}

export function TenantSelector({ value, onSelect, className }: TenantSelectorProps) {
  const { data, isLoading } = useTenants({ limit: 100 });
  const tenants: Tenant[] = data?.data ?? [];

  if (isLoading) {
    return <Skeleton className="h-10 w-64" />;
  }

  return (
    <Select
      value={value || ""}
      onValueChange={(id) => {
        const tenant = tenants.find(t => t.id === id);
        if (tenant) {
          onSelect(tenant.id, tenant.name);
        }
      }}
    >
      <SelectTrigger className={className || "w-64"}>
        <Store className="mr-2 h-4 w-4 text-muted-foreground" />
        <SelectValue placeholder="Select a tenant..." />
      </SelectTrigger>
      <SelectContent>
        {tenants.map((tenant) => (
          <SelectItem key={tenant.id} value={tenant.id}>
            <span className="font-medium">{tenant.name}</span>
            <span className="ml-2 text-muted-foreground text-xs">{tenant.slug}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
