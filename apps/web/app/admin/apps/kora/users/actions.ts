"use server";

// Server action, not a route handler — same reasoning as
// ../feedback/actions.ts and ../foods/actions.ts: lib/api/kora-admin.ts is
// server-only by construction and binds the ACTING ADMIN's session identity
// into the HMAC that deleteKoraUser sends. A route handler under
// /api/admin/kora/* would be a second public surface re-proxying this one
// call, and it would need its own authorization reasoning; a server action
// has no URL of its own and signs with the caller's own session.
//
// Called directly from the client delete button (not wired through
// useActionState/a <form action>), matching setFeedbackStatus's convention
// in ../feedback/actions.ts — the {ok:true}|{ok:false} union below is the
// return shape for a directly-awaited action, not useActionState's contract.

import { revalidatePath } from "next/cache";

import { KoraAdminError, deleteKoraUser, type KoraDeleteResult } from "@/lib/api/kora-admin";
import { logger } from "@/lib/logger";

export async function deleteUser(
  id: string,
): Promise<{ ok: true; result: KoraDeleteResult } | { ok: false; message: string }> {
  try {
    const result = await deleteKoraUser(id);
    // Revalidate the index (the deleted user must disappear from the list)
    // and this user's own detail route (a stale cache must never re-show a
    // "delete this user" form for someone who no longer exists).
    revalidatePath("/admin/apps/kora/users");
    revalidatePath(`/admin/apps/kora/users/${id}`);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof KoraAdminError) {
      logger.warn("[kora-users] delete rejected", { status: err.status });
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
