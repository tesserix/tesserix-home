"use server";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { recordDeniedAttempt } from "@/lib/db/denied-attempts";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import {
  featureFlagChangeSchema,
  featureFlagCommandSchema,
  type FeatureFlagWriteResult,
} from "@/lib/feature-flags-contract";

export async function changeHelivantaFeatureFlag(
  input: unknown,
): Promise<FeatureFlagWriteResult> {
  const session = await getCurrentSession();
  try {
    await checkOperatorCapabilityLive(session, "platform");
    await checkOperatorCapabilityLive(session, "manage-feature-flags");
    const parsed = featureFlagChangeSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        message:
          parsed.error.issues[0]?.message ?? "Review the change and reason.",
      };
    const { request_key, ...body } = parsed.data;
    const { data } = await platformRequestWithMeta(
      "feature flag change",
      "/v1/platform/feature-flags/helivanta/commands",
      {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request_key,
        },
        body: JSON.stringify(body),
      },
    );
    const command = featureFlagCommandSchema.parse(data);
    revalidatePath("/platform/feature-flags/helivanta");
    if (command.state === "succeeded")
      return {
        ok: true,
        command,
        message:
          command.code === "ALREADY_SET"
            ? "The flag is already in the requested state."
            : "Change confirmed. Active workspaces will refresh their feature availability.",
      };
    if (command.state === "failed")
      return {
        ok: false,
        command,
        message:
          "The change was not applied. Refresh the flags and review the command outcome before starting a new change.",
      };
    return {
      ok: true,
      command,
      message:
        "This change is unresolved. Editing is paused until its outcome can be confirmed.",
    };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      await recordDeniedAttempt({
        actor: session?.sub ?? session?.email ?? "unknown",
        required: cause.required,
        target: "feature-flags helivanta",
        kind: "verb",
      });
      return {
        ok: false,
        message:
          "You need platform and manage-feature-flags access to make this change.",
      };
    }
    if (cause instanceof PlatformApiError && cause.status === 409)
      return {
        ok: false,
        message:
          "Flags changed or another command is unresolved. Refresh and review before trying again.",
      };
    if (cause instanceof PlatformApiError && cause.status === 422)
      return {
        ok: false,
        message:
          "This feature is not eligible in the approved release. Review its prerequisites and release status.",
      };
    return {
      ok: false,
      message:
        "The change could not be confirmed. Refresh the flags and command history before trying again.",
    };
  }
}

const recoverySchema = z
  .object({ command: z.uuid(), operation: z.enum(["resume", "cancel"]) })
  .strict();

export async function recoverHelivantaFeatureFlag(
  input: unknown,
): Promise<FeatureFlagWriteResult> {
  const session = await getCurrentSession();
  try {
    await checkOperatorCapabilityLive(session, "platform");
    await checkOperatorCapabilityLive(session, "manage-feature-flags");
    const parsed = recoverySchema.safeParse(input);
    if (!parsed.success)
      return { ok: false, message: "Provide a valid queued command." };
    const { command: id, operation } = parsed.data;
    const { data } = await platformRequestWithMeta(
      "feature flag recovery",
      `/v1/platform/feature-flags/helivanta/commands/${id}/${operation}`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    const command = featureFlagCommandSchema.parse(data);
    revalidatePath("/platform/feature-flags/helivanta");
    return {
      ok:
        command.state !== "failed" ||
        command.code === "CANCELED_BEFORE_DISPATCH",
      command,
      message:
        command.code === "CANCELED_BEFORE_DISPATCH"
          ? "Queued change canceled before dispatch."
          : command.state === "succeeded"
            ? "Change confirmed."
            : command.state === "failed"
              ? "The queued request failed its current checks. Refresh and review the outcome."
              : "The command remains unresolved. Refresh its status; no uncertain publication will be retried.",
    };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      await recordDeniedAttempt({
        actor: session?.sub ?? session?.email ?? "unknown",
        required: cause.required,
        target: "feature-flags helivanta recovery",
        kind: "verb",
      });
      return {
        ok: false,
        message: "You need platform and manage-feature-flags access.",
      };
    }
    return {
      ok: false,
      message:
        "Recovery could not be confirmed. Refresh command history before continuing.",
    };
  }
}
