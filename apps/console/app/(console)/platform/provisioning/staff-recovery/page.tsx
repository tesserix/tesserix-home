import { createHash } from "node:crypto";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { notFound } from "next/navigation";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { StaffRecovery } from "@/components/provisioning/StaffRecovery";

export const dynamic = "force-dynamic";
export default async function StaffRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{
    tenantId?: string;
    commandId?: string;
    requestId?: string;
  }>;
}) {
  const session = await getCurrentSession();
  if (!session) notFound();
  try {
    await checkOperatorCapabilityLive(session, "platform");
  } catch (cause) {
    if (cause instanceof CapabilityError) notFound();
    throw cause;
  }
  let canWrite = false;
  try {
    await checkOperatorCapabilityLive(session, "rotate-credentials");
    canWrite = true;
  } catch (cause) {
    if (!(cause instanceof CapabilityError)) throw cause;
  }
  const params = await searchParams;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return (
    <StaffRecovery
      initialScope={{
        tenantId: text(params.tenantId),
        commandId: text(params.commandId),
        requestId: text(params.requestId) || undefined,
      }}
      operator={{
        subject: session.sub,
        sessionKey: createHash("sha256")
          .update(`${session.sub}:${session.sid ?? ""}`)
          .digest("hex"),
        canWrite,
      }}
    />
  );
}
