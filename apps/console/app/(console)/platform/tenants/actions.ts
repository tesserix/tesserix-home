"use server";

import type { LifecycleVerb } from "@/lib/tenant-lifecycle";
import {
  setTenantLifecycle,
  type LifecycleWriteResult,
} from "@/lib/tenant-lifecycle-write";

/**
 * The tenant directory's one write, as a server action.
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
