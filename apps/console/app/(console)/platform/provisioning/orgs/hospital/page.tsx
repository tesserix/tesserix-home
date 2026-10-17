import { HospitalOnboarding } from "@/components/provisioning/HospitalOnboarding";

export default async function HospitalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string }>;
}) {
  const { tenantId } = await searchParams;
  return <HospitalOnboarding initialTenantId={tenantId} />;
}
