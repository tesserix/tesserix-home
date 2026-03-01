import { redirect } from "next/navigation";

export default function TenantDetailPage({
  params,
}: {
  params: { id: string };
}) {
  redirect(`/admin/apps/mark8ly/${params.id}`);
}
