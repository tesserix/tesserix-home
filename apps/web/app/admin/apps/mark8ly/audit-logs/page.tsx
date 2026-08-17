import { AuditLogsPageLayout } from "@/components/admin/audit-logs-page-layout";
import { getProductConfig } from "@/lib/products/configs";

export default async function Mark8lyAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  const sp = await searchParams;
  return (
    <AuditLogsPageLayout
      config={getProductConfig("mark8ly")}
      initialSeverity={sp.severity}
    />
  );
}
