import {
  CapabilityError,
  hasCapability,
  isPlatformOperator,
  type Capability,
} from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";

/**
 * The console's verb gate: every server action that mutates state calls this
 * before doing anything else.
 *
 * Provider-gated exactly like `isInternal` and for the same reason — legacy
 * google sessions carry no roles claim, so requiring one under that provider
 * would refuse every write in local dev. A missing session is refused
 * unconditionally: middleware already gates the route, but a verb must fail
 * closed on its own rather than inherit safety from routing.
 */
export function checkOperatorCapability(
  session: { roles?: readonly string[]; email?: string } | null,
  required: Capability,
  provider: string | undefined = process.env.AUTH_PROVIDER,
): void {
  if (!session) {
    throw new CapabilityError(required);
  }
  if (!requiresCapability(provider)) {
    return;
  }
  if (isPlatformOperator(session.email)) {
    return;
  }
  if (!hasCapability(session.roles, required)) {
    throw new CapabilityError(required);
  }
}
