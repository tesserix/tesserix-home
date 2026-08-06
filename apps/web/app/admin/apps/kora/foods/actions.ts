"use server";

// Server actions for Kora's food mutations.
//
// WHY SERVER ACTIONS AND NOT ROUTE HANDLERS. lib/api/kora-admin.ts is
// server-only by construction: it reads KORA_BFF_HMAC_KEY from the process
// environment and calls getCurrentSession() to bind the ACTING ADMIN's
// identity into the HMAC — that identity is what kora writes to
// kora_admin_events.actor_email. A route handler under /api/admin/kora/*
// would be a second HTTP surface that only re-proxies these three calls, and
// every one of them would need its own authorization reasoning. A server
// action has no public URL of its own, and the session it signs with is the
// caller's, so attribution cannot drift from who is actually logged in.
//
// Middleware already requires a session for everything outside PUBLIC_PATHS
// (see middleware.ts), so both options are session-gated; this one is simply
// less surface.

import { revalidatePath } from "next/cache";

import {
  KoraAdminError,
  createKoraFood,
  deleteKoraFood,
  updateKoraFood,
  type KoraFoodInput,
} from "@/lib/api/kora-admin";
import { logger } from "@/lib/logger";
import type { FoodActionState } from "./action-state";

// FoodActionState and IDLE_STATE live in ./action-state.ts, NOT here: a
// "use server" file may only export async functions (every export becomes a
// callable server endpoint), so exporting the IDLE_STATE object from this file
// fails the build. Re-exported below for the actions' own callers.


/**
 * Reads one required number from the form. Returns `null` for absent, blank,
 * or non-numeric input rather than coercing to 0 — `Number("")` is 0, so a
 * blank macro field would otherwise submit a confident, wrong zero to a
 * nutrition database. Kora rejects a missing macro too (its payload fields are
 * pointers for exactly this reason); catching it here just makes the message
 * land next to the field.
 */
function numberField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function stringField(form: FormData, name: string): string {
  const raw = form.get(name);
  return typeof raw === "string" ? raw.trim() : "";
}

const MACRO_FIELDS = [
  "serving_grams",
  "kcal_per_100g",
  "protein_per_100g",
  "carbs_per_100g",
  "fat_per_100g",
  "fiber_per_100g",
] as const;

/**
 * Builds a KoraFoodInput from the submitted form, or returns the first
 * validation failure. Deliberately does NOT re-implement kora's bounds
 * (non-negative, per-100g magnitude): kora validates authoritatively and this
 * layer would drift from it. This only catches what kora cannot attribute to a
 * field — absent and non-numeric — so the operator sees which input was wrong.
 */
function readForm(form: FormData): { input: KoraFoodInput } | { error: FoodActionState } {
  const name = stringField(form, "name");
  if (!name) {
    return { error: { status: "error", code: "invalid_input", message: "Name is required." } };
  }

  const numbers: Record<string, number> = {};
  for (const field of MACRO_FIELDS) {
    const value = numberField(form, field);
    if (value === null) {
      return {
        error: {
          status: "error",
          code: "invalid_input",
          message: `${field.replace(/_/g, " ")} must be a number.`,
        },
      };
    }
    numbers[field] = value;
  }

  const barcode = stringField(form, "barcode");
  const provenance = stringField(form, "provenance");

  return {
    input: {
      name,
      brand: stringField(form, "brand"),
      // Omit rather than send "" — kora defaults an absent provenance to
      // "curated" but rejects an unrecognised one, and "" is unrecognised.
      ...(provenance ? { provenance } : {}),
      // null, not "": kora treats a null barcode as "no barcode" and would
      // otherwise have an empty string competing for the unique index.
      barcode: barcode || null,
      serving_desc: stringField(form, "serving_desc"),
      serving_grams: numbers.serving_grams,
      kcal_per_100g: numbers.kcal_per_100g,
      protein_per_100g: numbers.protein_per_100g,
      carbs_per_100g: numbers.carbs_per_100g,
      fat_per_100g: numbers.fat_per_100g,
      fiber_per_100g: numbers.fiber_per_100g,
    },
  };
}

/**
 * Turns a thrown error into a state the UI can branch on. A KoraAdminError
 * keeps its code and message — `stale_update` and `duplicate_barcode` are the
 * two the operator can actually act on, and collapsing them into "something
 * went wrong" removes the only useful part. Anything else is logged in full
 * server-side and reported generically.
 */
function toErrorState(err: unknown, context: string): FoodActionState {
  if (err instanceof KoraAdminError) {
    return { status: "error", code: err.code, message: err.message, httpStatus: err.status };
  }
  logger.error(`[kora-admin-action] ${context} failed`, err);
  return { status: "error", code: "unknown_error", message: "Something went wrong. Please try again." };
}

export async function createFoodAction(
  _prev: FoodActionState,
  form: FormData,
): Promise<FoodActionState> {
  const parsed = readForm(form);
  if ("error" in parsed) return parsed.error;

  try {
    const result = await createKoraFood(parsed.input);
    revalidatePath("/admin/apps/kora/foods");
    return {
      status: "success",
      createdId: result.food.id,
      cacheBumpFailed: result.cacheBumpFailed,
      message: `Created “${result.food.name}”.`,
    };
  } catch (err) {
    return toErrorState(err, "create");
  }
}

export async function updateFoodAction(
  _prev: FoodActionState,
  form: FormData,
): Promise<FoodActionState> {
  const id = stringField(form, "id");
  // The updated_at the form LOADED, echoed back as the optimistic-concurrency
  // precondition. Its absence is a bug in the form, not operator error — fail
  // loudly rather than silently editing without a precondition.
  const expectedUpdatedAt = stringField(form, "updated_at");
  if (!expectedUpdatedAt) {
    return {
      status: "error",
      code: "missing_precondition",
      message: "This form is missing its concurrency token. Reload the page and try again.",
    };
  }

  const parsed = readForm(form);
  if ("error" in parsed) return parsed.error;

  try {
    const result = await updateKoraFood(id, parsed.input, expectedUpdatedAt);
    revalidatePath("/admin/apps/kora/foods");
    revalidatePath(`/admin/apps/kora/foods/${id}`);
    return {
      status: "success",
      // The NEW updated_at, so a second edit in the same session carries a
      // fresh precondition instead of 409ing against the operator's own write.
      updatedAt: result.food.updated_at,
      cacheBumpFailed: result.cacheBumpFailed,
      message: "Saved.",
    };
  } catch (err) {
    return toErrorState(err, "update");
  }
}

export async function deleteFoodAction(
  _prev: FoodActionState,
  form: FormData,
): Promise<FoodActionState> {
  const id = stringField(form, "id");
  try {
    const result = await deleteKoraFood(id);
    revalidatePath("/admin/apps/kora/foods");
    revalidatePath(`/admin/apps/kora/foods/${id}`);
    return {
      status: "success",
      cacheBumpFailed: result.cacheBumpFailed,
      // Reads deleted_at off the response rather than assuming the 200 meant
      // retirement — that field existing is why kora returns a snapshot.
      message: result.food.deleted_at
        ? `Retired “${result.food.name}”.`
        : `“${result.food.name}” was not retired — kora returned no deleted_at.`,
    };
  } catch (err) {
    return toErrorState(err, "delete");
  }
}
