// `server-only`: this reads the operator's session and their platform API
// token. A client component importing it must fail the build.
import "server-only";

import { randomUUID } from "node:crypto";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import type { LifecycleVerb } from "@/lib/tenant-lifecycle";

/**
 * Suspending and unsuspending a tenant, through the product that owns it.
 *
 * # A sibling of withToolsWrite, not a caller of it
 *
 * Same reason tools-write is a sibling of crm-write: the audit row for this
 * change is written by the PRODUCT, inside its own transaction, bound to the
 * state change it describes. mark8ly records `tenant.suspended` itself. Adding
 * a console-side audit row here would put a second, less trustworthy account
 * of the same event in a different database — and the two would disagree the
 * first time a write half-succeeded.
 *
 * # This is the console's first federated WRITE
 *
 * Every write before it reached a database this service owns. This one crosses
 * into another product, which changes what a failure means: a transport error
 * after mark8ly committed is indistinguishable from one before it. That is why
 * the messages below never say "nothing was changed" — see NOT_APPLIED.
 */
export type LifecycleWriteResult =
  | { ok: true; changed: boolean; status: string; storesAffected: number }
  | { ok: false; message: string; field?: string };

const NO_PERMISSION = "You do not have permission to change a tenant's status.";

/**
 * Deliberately does NOT say "nothing changed".
 *
 * When a federated write fails there are two possibilities and this service
 * cannot tell them apart: the product never applied it, or it applied it and
 * the answer was lost. Telling an operator "nothing changed" asserts the first,
 * and if it is the second they will suspend an already-suspended tenant, or
 * worse, believe a suspension did not take. "Could not be confirmed" is the
 * honest shape, and it points at the directory — which reads the product's
 * actual state — rather than inviting a blind retry.
 */
const NOT_APPLIED =
  "That change could not be confirmed. Reload the directory to see the tenant's current status before trying again.";

const UNKNOWN_TENANT =
  "That tenant is not one this console can reach — reload the directory.";

const LABEL = "tenants";

/**
 * Recover the API's own sentence from a PlatformApiError.
 *
 * Same anchoring trick tools-write uses and for the same reason: the envelope
 * formats as `${label}: ${CODE} — ${message}`, and our messages contain
 * em-dashes of their own, so splitting on the first one truncates them.
 */
function apiMessage(error: PlatformApiError): string | undefined {
  const withoutLabel = error.message.startsWith(`${LABEL}: `)
    ? error.message.slice(LABEL.length + 2)
    : error.message;
  return /^[A-Z_]+ — ([\s\S]+)$/.exec(withoutLabel)?.[1];
}

interface LifecycleResponse {
  readonly tenant_id?: unknown;
  readonly status?: unknown;
  readonly stores_affected?: unknown;
  readonly changed?: unknown;
}

/**
 * Change one tenant's lifecycle state.
 *
 * `tenantId` is the NAMESPACED id the directory renders (`<source>:<id>`).
 * platform-api splits it to decide which product to call, so passing the
 * product's bare id would be refused rather than silently aimed at a default.
 */
export async function setTenantLifecycle(
  tenantId: string,
  verb: LifecycleVerb,
  reasonCode: string,
  reason: string,
): Promise<LifecycleWriteResult> {
  try {
    const session = await getCurrentSession();
    // Checked here as well as by the API, which remains the authorisation
    // boundary: this stops the console sending a request it already knows will
    // be refused, and makes the failure read as "you do not have permission"
    // rather than as a transport error.
    checkOperatorCapability(session, "platform");

    const body = await platformRequestWithMeta(
      LABEL,
      `/v1/tenants/${encodeURIComponent(tenantId)}/${verb}`,
      {
        method: "POST",
        headers: {
          // Minted per call. It makes THIS request retryable at the transport
          // level; it does not make the form idempotent. An operator
          // submitting twice mints two keys and means it twice — which is
          // correct, because suspending an already-suspended tenant is a
          // legitimate no-op the product reports as `changed: false`.
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason_code: reasonCode, reason }),
      },
    );

    const data = (body as { data?: LifecycleResponse } | undefined)?.data ?? {};
    return {
      ok: true,
      // `changed` is read from the product rather than assumed. Suspending an
      // already-suspended tenant succeeds and changes nothing, and reporting
      // that as a fresh suspension would put a false event in the operator's
      // head and in the story they tell afterwards.
      changed: data.changed === true,
      status: typeof data.status === "string" ? data.status : "",
      storesAffected: typeof data.stores_affected === "number" ? data.stores_affected : 0,
    };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION };
    }
    if (cause instanceof PlatformApiError) {
      const message = apiMessage(cause);
      switch (cause.status) {
        case 400:
          // The API's own sentence. For a refused reason code it reads "the
          // product refused this change: invalid_reason_code" — which names
          // the field, so it belongs on the input rather than the form.
          return {
            ok: false,
            message: message ?? NOT_APPLIED,
            field: message?.includes("reason_code") ? "reasonCode" : undefined,
          };
        case 403:
          return { ok: false, message: NO_PERMISSION };
        case 404:
          return { ok: false, message: UNKNOWN_TENANT };
        default:
          // 503 included: the product could not be reached. Whether it applied
          // the change is unknowable from here.
          return { ok: false, message: NOT_APPLIED };
      }
    }
    return { ok: false, message: NOT_APPLIED };
  }
}
