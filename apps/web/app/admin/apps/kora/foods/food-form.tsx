"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { IDLE_STATE, type FoodActionState } from "./actions";
import type { KoraFoodSnapshot } from "@/lib/api/kora-admin";

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50";

// Kora's closed provenance set (nutrition/model.go). Rendered as a select, not
// a free-text field: kora rejects an unrecognised value, and provenance is
// filtered and grouped on, so a typo would create a row that silently drops
// out of every report.
const PROVENANCE_OPTIONS = ["curated", "afcd", "off", "usda", "label_ocr", "user_estimate"];

const MACROS: Array<{ name: string; label: string; step: string }> = [
  { name: "kcal_per_100g", label: "Kcal / 100g", step: "0.1" },
  { name: "protein_per_100g", label: "Protein / 100g", step: "0.1" },
  { name: "carbs_per_100g", label: "Carbs / 100g", step: "0.1" },
  { name: "fat_per_100g", label: "Fat / 100g", step: "0.1" },
  { name: "fiber_per_100g", label: "Fiber / 100g", step: "0.1" },
];

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  step,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string | number;
  type?: string;
  step?: string;
  required?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase text-muted-foreground">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        required={required}
        defaultValue={defaultValue}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  // useFormStatus must be read from a component INSIDE the <form>, which is
  // why this is its own component rather than a hook call in FoodForm.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-9 rounded-md bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Renders the outcome of a mutation.
 *
 * The three-way split is the whole point (rider 4): a committed edit whose
 * cache bump failed is a SUCCESS with a warning, not a failure. Telling an
 * operator their edit failed when it landed makes them do it again — and with
 * the updated_at precondition in place, the retry would 409 against their own
 * write and look like a second, unrelated fault.
 */
function ActionResult({ state }: { state: FoodActionState }) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    const hint =
      state.code === "stale_update"
        ? "Someone else edited this food since you loaded it. Reload the page to see their changes, then reapply yours."
        : state.code === "duplicate_barcode"
          ? "That barcode already belongs to another food — including one that has been retired."
          : null;
    return (
      <div
        role="alert"
        className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
      >
        <p className="font-medium">{hint ?? "That change could not be saved."}</p>
        <p className="mt-1">
          {state.httpStatus ? `Status ${state.httpStatus} — ` : ""}
          {state.code}
          {state.message ? `: ${state.message}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
    >
      <p className="font-medium">{state.message ?? "Saved."}</p>
      {state.cacheBumpFailed ? (
        <p className="mt-1">
          Saved successfully, but Kora&apos;s resolve cache could not be invalidated — users may
          still be served the previous values for up to 24 hours. No action is needed on this form.
        </p>
      ) : null}
      {state.createdId ? (
        <p className="mt-1">
          <Link href={`/admin/apps/kora/foods/${state.createdId}`} className="underline">
            Open the new food
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Create/edit form for one Kora food.
 *
 * `food` absent = create. `food` present = edit, and the form carries that
 * row's `updated_at` in a hidden field as PATCH's concurrency precondition.
 * The hidden value is keyed off `state.updatedAt` after a successful save, so
 * a second edit in the same session sends a FRESH precondition rather than
 * 409ing against the operator's own previous write.
 */
export function FoodForm({
  food,
  action,
}: {
  food?: KoraFoodSnapshot;
  action: (prev: FoodActionState, form: FormData) => Promise<FoodActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const currentUpdatedAt = state.updatedAt ?? food?.updated_at ?? "";

  return (
    <form action={formAction} className="space-y-6">
      {food ? <input type="hidden" name="id" value={food.id} /> : null}
      {food ? <input type="hidden" name="updated_at" value={currentUpdatedAt} /> : null}

      <ActionResult state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Name" defaultValue={food?.name} required />
        <Field name="brand" label="Brand" defaultValue={food?.brand} />

        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Provenance</span>
          <select
            name="provenance"
            defaultValue={food?.provenance ?? "curated"}
            className={INPUT_CLASS}
          >
            {PROVENANCE_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <Field name="barcode" label="Barcode (optional)" defaultValue={food?.barcode ?? ""} />
        <Field name="serving_desc" label="Serving description" defaultValue={food?.serving_desc} />
        <Field
          name="serving_grams"
          label="Serving grams"
          type="number"
          step="0.1"
          defaultValue={food?.serving_grams}
          required
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {MACROS.map((m) => (
          <Field
            key={m.name}
            name={m.name}
            label={m.label}
            type="number"
            step={m.step}
            defaultValue={food?.[m.name as keyof KoraFoodSnapshot] as number | undefined}
            required
          />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton
          label={food ? "Save changes" : "Create food"}
          pendingLabel={food ? "Saving…" : "Creating…"}
        />
        <Link
          href="/admin/apps/kora/foods"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

/**
 * Delete (retire) confirmation.
 *
 * `logCount` comes from kora's food-detail endpoint, never from a count
 * invented here — the task brief is explicit about that, and a client-side
 * guess would be wrong in exactly the situation an operator most needs it to
 * be right.
 */
export function DeleteFoodForm({
  food,
  logCount,
  action,
}: {
  food: KoraFoodSnapshot;
  logCount: number;
  action: (prev: FoodActionState, form: FormData) => Promise<FoodActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  if (food.deleted_at) {
    return (
      <p className="text-sm text-muted-foreground">
        This food was retired on {new Date(food.deleted_at).toLocaleString()}. It no longer appears
        in search, the food index, or barcode lookups.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={food.id} />

      <ActionResult state={state} />

      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <p className="font-medium">
          {logCount === 0
            ? "No logs reference this food."
            : `${logCount.toLocaleString("en-US")} ${logCount === 1 ? "log references" : "logs reference"} this food.`}
        </p>
        <p className="mt-1">
          Retiring hides it from search, the food index and barcode lookups. Existing logs keep
          their recorded values and continue to render — this is a soft delete, so nothing is
          destroyed and it can be reversed in the database.
        </p>
      </div>

      <SubmitButton label="Retire this food" pendingLabel="Retiring…" />
    </form>
  );
}
