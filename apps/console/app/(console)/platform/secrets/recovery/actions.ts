"use server";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { auditedOperation } from "@/lib/db/audit-repo";
import { PlatformApiError } from "@/lib/platform-api-error";
import { startRecoveryOperation } from "@/lib/recovery-api";
import type { RecoveryActionResult } from "@/lib/recovery";

export async function startRecoveryAction(_previous: RecoveryActionResult, form: FormData): Promise<RecoveryActionResult> {
  try {
    const session = await getCurrentSession();
    const job = await auditedOperation({
      actor: session?.sub ?? "unknown",
      target: "openbao-recovery",
      operation: async () => {
        await checkOperatorCapabilityLive(session, "platform");
        await checkOperatorCapabilityLive(session, "rotate-credentials");
        const operation = form.get("operation");
        const key = form.get("idempotencyKey");
        if ((operation !== "backup" && operation !== "restore-test") || typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new Error("Invalid recovery request");
        return startRecoveryOperation(operation, key);
      },
      describe: (result) => ({ action: "secrets.recovery.start", target: result.name, summary: { operations: 1 } }),
    });
    revalidatePath("/platform/secrets/recovery");
    return { ok: true, message: `Operation ${job.phase.toLowerCase()}. Refresh status to see its progress.` };
  } catch (cause) {
    if (cause instanceof CapabilityError || (cause instanceof PlatformApiError && cause.status === 403)) {
      return { ok: false, message: "You need platform and credential-management permissions to start this operation." };
    }
    return { ok: false, message: "The operation could not be confirmed. Retry this form to safely check the same request." };
  }
}
