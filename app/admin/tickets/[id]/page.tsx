import { redirect } from "next/navigation";

export default async function TicketDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/admin/apps/mark8ly/tickets/${id}`);
}
