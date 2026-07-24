import { TenantDetailLayout } from "@/components/admin/tenant-detail-layout";
import { getProductConfig } from "@/lib/products/configs";

export default async function Mark8lyTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TenantDetailLayout config={getProductConfig("mark8ly")} tenantId={id} />;
}
