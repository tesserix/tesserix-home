"use client";

import { ConsoleDataTable } from "@/components/kit/console-data-table";
import Link from "next/link";

import { Badge, Card, Empty, ErrorNote, PageTitle } from "@/components/provisioning/ui";
import { useApi } from "@/lib/provisioning/useApi";
import type { Product } from "@/lib/provisioning/types";

export default function ProductsPage() {
  const { data, error } = useApi<{ products: Product[] }>("/v1/products");
  const products = data?.products ?? [];

  return (
    <div className="space-y-8">
      <PageTitle
        title="Products"
        description="Projects onboarded to the platform and how each one carries identity and tenant secrets."
      />
      <ErrorNote error={error} />
      <Card
        title="Products"
        action={
          <Link
            href="/platform/provisioning/products/new"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            New product
          </Link>
        }
      >
        {products.length === 0 ? (
          <Empty>No products yet.</Empty>
        ) : (
          <ConsoleDataTable<Product> rows={products} rowKey={(p)=>p.key} label="Products" total={products.length} page={1} pageSize={Math.max(1,products.length)} onPageChange={()=>{}} state={{kind:"ready"}} emptyMessage="No products yet." columns={[
            {key:"name",header:"Product",cell:p=><><span className="font-medium">{p.displayName}</span><span className="block font-mono text-xs">{p.key}</span></>},
            {key:"identity",header:"Identity",cell:p=><Badge tone={p.identity==="zitadel"?"ok":"muted"}>{p.identity}</Badge>},
            {key:"secrets",header:"Customer secrets",cell:p=>p.tenantSecrets},
            {key:"tenancy",header:"Tenancy",cell:p=>p.tenancy},
            {key:"roles",header:"Roles",cell:p=>p.roles.join(", ")||"—"},
            {key:"hosts",header:"Hosts",cell:p=>p.hosts?.join(", ")||"—"},
          ]}/>
        )}
      </Card>
    </div>
  );
}
