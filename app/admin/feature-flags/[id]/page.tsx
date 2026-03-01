import { redirect } from "next/navigation";

export default async function ExperimentDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/admin/apps/mark8ly/feature-flags/${id}`);
}
