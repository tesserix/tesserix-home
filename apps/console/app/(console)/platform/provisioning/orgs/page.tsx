"use client";

import { ConsoleDataTable } from "@/components/kit/console-data-table";
import Link from "next/link";
import { useState } from "react";

import { Badge, Card, Empty, ErrorNote, inputClass, PageTitle } from "@/components/provisioning/ui";
import { useApi } from "@/lib/provisioning/useApi";
import type { Organization } from "@/lib/provisioning/types";

export default function OrgsPage() {
  const [search, setSearch] = useState("");
  const { data, error } = useApi<{ organizations: Organization[] }>("/v1/orgs");

  const needle = search.trim().toLowerCase();
  const orgs = (data?.organizations ?? []).filter(
    (o) =>
      needle === "" ||
      o.name.toLowerCase().includes(needle) ||
      (o.primaryDomain ?? "").toLowerCase().includes(needle) ||
      (o.externalRef ?? "").toLowerCase().includes(needle),
  );

  return (
    <div className="space-y-8">
      <PageTitle
        title="Organizations"
        description="Every customer organization, and which product created it."
        actions={
          <div className="flex gap-4">
            <Link
              href="/platform/provisioning/orgs/hospital"
              className="text-sm font-medium underline underline-offset-4"
            >
              Onboard hospital
            </Link>
            <Link href="/platform/provisioning/orgs/enrol" className="text-sm font-medium underline underline-offset-4">
              Enrol existing organisation
            </Link>
          </div>
        }
      />
      <ErrorNote error={error} />
      <Card
        title="Organizations"
        action={
          <Link
            href="/platform/provisioning/orgs/new"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            New organization
          </Link>
        }
      >
        <input
          className={`${inputClass} mb-4`}
          placeholder="Search by name, domain or external reference"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {orgs.length === 0 ? (
          <Empty>No organizations.</Empty>
        ) : (
          <ConsoleDataTable<Organization> rows={orgs} rowKey={org=>org.id} label="Customer tenants" total={orgs.length} page={1} pageSize={Math.max(1,orgs.length)} onPageChange={()=>{}} state={{kind:"ready"}} emptyMessage="No organizations." columns={[
            {key:"name",header:"Name",cell:org=><><Link href={`/platform/provisioning/orgs/${org.id}`} className="font-medium hover:underline">{org.name}</Link><span className="block font-mono text-xs">{org.id}</span></>},
            {key:"domain",header:"Domain",cell:org=>org.primaryDomain??"—"},
            {key:"product",header:"Onboarded by",cell:org=>org.createdByProduct||"platform"},
            {key:"plan",header:"Plan",cell:org=>org.plan??"—"},
            {key:"state",header:"State",cell:org=><Badge tone={org.state==="active"?"ok":"muted"}>{org.state}</Badge>},
          ]}/>
        )}
      </Card>
    </div>
  );
}
