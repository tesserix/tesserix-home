"use server";

// Server action, not a route handler — same reasoning as the food mutations
// in ../foods/actions.ts: lib/api/kora-admin.ts is server-only by
// construction and binds the ACTING ADMIN's session identity into the HMAC.
// A route handler would be a second public surface needing its own
// authorization reasoning; a server action has no URL of its own.
//
// This is called directly from the client table's onChange handler (not
// wired through useActionState/a <form action>), so it does not use
// ../foods/actions.ts's FoodActionState — that type's idle/success shape
// and its (_prevState, formData) signature exist for useActionState's
// contract, which this control does not use. The {ok:true}|{ok:false}
// union below is the return convention for a directly-awaited action.

import { revalidatePath } from "next/cache";

import { KoraAdminError, updateKoraFeedbackStatus } from "@/lib/api/kora-admin";
import { logger } from "@/lib/logger";

export async function setFeedbackStatus(
  id: string,
  status: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await updateKoraFeedbackStatus(id, status);
    revalidatePath("/admin/apps/kora/feedback");
    return { ok: true };
  } catch (err) {
    if (err instanceof KoraAdminError) {
      logger.warn("[kora-feedback] status update rejected", { status: err.status });
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
