// The shape server actions in ./actions.ts return, kept in a PLAIN module.
//
// It cannot live in actions.ts: that file carries "use server", and such a
// file may only export async functions — every export becomes a callable
// server endpoint, so a plain object export is rejected at build time
// ("A 'use server' file can only export async functions, found object").
// The type alone would have been fine (types are erased), but IDLE_STATE is a
// runtime value, so both move here and actions.ts re-uses them.
//
// Worth knowing: neither `tsc --noEmit` nor vitest catches that rule — only a
// real `next build` does.

export interface FoodActionState {
  status: "idle" | "success" | "error";
  /** Kora's error code, e.g. "stale_update" or "duplicate_barcode". */
  code?: string;
  message?: string;
  httpStatus?: number;
  /**
   * Rider 4: the mutation COMMITTED but the resolve cache could not be
   * invalidated. Rendered as a warning ON a success, never as a failure.
   */
  cacheBumpFailed?: boolean;
  /** The id a create produced, so the form can link to the new food. */
  createdId?: string;
  /** Fresh updated_at after a successful edit, so the form can keep editing. */
  updatedAt?: string;
}

export const IDLE_STATE: FoodActionState = { status: "idle" };
