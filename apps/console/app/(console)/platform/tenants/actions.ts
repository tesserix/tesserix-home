"use server";

import type { LifecycleVerb } from "@/lib/tenant-lifecycle";
import {
  setTenantLifecycle,
  type LifecycleWriteResult,
} from "@/lib/tenant-lifecycle-write";
import {
  grantTenantPricingOverride,
  type PricingOverrideWriteResult,
  type TenantPricingOverrideInput,
} from "@/lib/tenant-pricing-override-write";

/**
 * Suspending and unsuspending a tenant, as a server action.
 *
 * A shell, exactly like `platform/tools/actions.ts`: the seam owns the
 * session, the capability check, the request and the error mapping, and this
 * owns nothing but the boundary. It exists because `lib/tenant-lifecycle-write`
 * opens with `import "server-only"` — the row control that calls it is a
 * client component, and importing the seam from there is a build error by
 * design.
 *
 * # Why there is no revalidatePath here, unlike the tools actions
 *
 * The tools surface revalidates because its directory is a cached read of a
 * table this estate owns. This one is not: `fetchEstateTenants` fetches with
 * `cache: "no-store"` and the page is rendered per-request from its search
 * params, so there is no server cache entry to evict. What CAN be stale is the
 * client's router cache, and only the browser can drop that — the caller runs
 * `router.refresh()` on success, which re-reads the products rather than
 * re-rendering the console's own idea of their state.
 *
 * Nothing here audits. The product wrote that row inside the transaction that
 * changed the tenant; see `lib/tenant-lifecycle-write.ts`.
 */
export async function setTenantLifecycleAction(
  tenantId: string,
  verb: LifecycleVerb,
  reasonCode: string,
  reason: string,
): Promise<LifecycleWriteResult> {
  return setTenantLifecycle(tenantId, verb, reasonCode, reason);
}

/**
 * Minting one tenant's pricing override, as a server action (#331, T2).
 *
 * A second shell beside {@link setTenantLifecycleAction}, owning nothing for
 * the same reason: `lib/tenant-pricing-override-write` opens with
 * `import "server-only"`, and the dialog that calls it is a client component.
 * The seam owns the session, both capability checks, the validation, the mint
 * and the error mapping.
 *
 * The revalidatePath argument above applies unchanged — the tenant directory
 * is a per-request `cache: "no-store"` read, so there is no server cache entry
 * to evict, and the caller runs `router.refresh()` instead.
 *
 * Nothing here audits the GRANT. `grantTenantPricingOverride` audits the
 * console's own act — it minted a Stripe object — and the grant's audit row is
 * mark8ly's, written inside the transaction that applies the coupon (#660,
 * T3). Until T3 exists, nothing applies it: a successful return means a coupon
 * was minted and recorded, not that the tenant is being charged less.
 */
export async function grantTenantPricingOverrideAction(
  input: TenantPricingOverrideInput,
): Promise<PricingOverrideWriteResult> {
  return grantTenantPricingOverride(input);
}
