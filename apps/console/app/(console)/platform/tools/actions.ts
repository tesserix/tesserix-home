"use server";

import { revalidatePath } from "next/cache";
import {
  createGroup,
  createTool,
  deleteGroup,
  deleteTool,
  updateGroup,
  updateTool,
  type ToolInput,
  type ToolsWriteResult,
} from "@/lib/tools-write";

/**
 * The eight writes this surface performs.
 *
 * Each is a thin shell: the seam owns the capability check, the request and
 * the error mapping, and these own revalidation. Revalidation covers BOTH this
 * page and "/" because the home page renders the same directory from the same
 * loader — refreshing only this page would leave the cards stale and make a
 * successful edit look like a failed one.
 *
 * Nothing here audits. The Go module already recorded the row; see
 * lib/tools-write.ts.
 */
function refresh(): void {
  revalidatePath("/platform/tools");
  revalidatePath("/");
}

/** Revalidate on success only. A failed write changed nothing, and evicting
 *  the cache would send every reader back to the API for the same answer. */
function settle(result: ToolsWriteResult): ToolsWriteResult {
  if (result.ok) refresh();
  return result;
}

export async function addToolAction(input: ToolInput): Promise<ToolsWriteResult> {
  return settle(await createTool(input));
}

export async function editToolAction(
  id: string,
  patch: Partial<Omit<ToolInput, "note">> & { note?: string | null },
): Promise<ToolsWriteResult> {
  return settle(await updateTool(id, patch));
}

export async function removeToolAction(id: string): Promise<ToolsWriteResult> {
  return settle(await deleteTool(id));
}

/**
 * Swap two tools' positions by exchanging their stored `sort_order`.
 *
 * TWO PATCHes, and deliberately not atomic — the API has no reorder endpoint.
 * If the second fails, both rows briefly share a sort_order; the API orders by
 * `g.sort_order, t.sort_order, t.name`, so the tie breaks by name and the page
 * still renders deterministically. The operator retries. Stated in the spec
 * rather than discovered in production.
 */
export async function moveToolAction(
  moving: { id: string; sortOrder: number },
  neighbour: { id: string; sortOrder: number },
): Promise<ToolsWriteResult> {
  const first = await updateTool(moving.id, { sortOrder: neighbour.sortOrder });
  if (!first.ok) return first;
  const second = await updateTool(neighbour.id, { sortOrder: moving.sortOrder });
  // Leg 1's write already landed even when leg 2 fails: the database changed
  // and the cached page has not, so refresh() runs on BOTH paths below, not
  // only the success one. Skipping it here would show an error alongside an
  // unchanged list — reading as "nothing happened" when half of it did.
  refresh();
  if (!second.ok) return second;
  return { ok: true };
}

export async function addGroupAction(input: {
  key: string;
  label: string;
}): Promise<ToolsWriteResult> {
  return settle(await createGroup(input));
}

export async function renameGroupAction(key: string, label: string): Promise<ToolsWriteResult> {
  return settle(await updateGroup(key, { label }));
}

export async function removeGroupAction(key: string): Promise<ToolsWriteResult> {
  return settle(await deleteGroup(key));
}

/** The group equivalent of moveToolAction, with the same non-atomicity. */
export async function moveGroupAction(
  moving: { key: string; sortOrder: number },
  neighbour: { key: string; sortOrder: number },
): Promise<ToolsWriteResult> {
  const first = await updateGroup(moving.key, { sortOrder: neighbour.sortOrder });
  if (!first.ok) return first;
  const second = await updateGroup(neighbour.key, { sortOrder: moving.sortOrder });
  // Same reasoning as moveToolAction: leg 1's write landed regardless of leg
  // 2's outcome, so refresh() runs on both paths.
  refresh();
  if (!second.ok) return second;
  return { ok: true };
}
