"use client";

import { useState, useTransition } from "react";

import { canDelete, postDeleteWarning } from "./guards";
import { deleteUser } from "../actions";
import type { KoraDeleteResult, KoraUserDetail } from "@/lib/api/kora-admin";

// "use client" because the confirmation input and delete button mutate —
// matches the reasoning in feedback-table.tsx/food-form.tsx for why those
// mutating surfaces are client components while their host pages stay
// server-rendered. Not unit tested directly (same as those two); its logic
// worth pinning (canDelete, postDeleteWarning) lives in ./guards.ts instead.

export function DeleteUser({ user }: { user: KoraUserDetail }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KoraDeleteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (result) {
    const warning = postDeleteWarning(result);
    return (
      <div
        role="status"
        className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
      >
        <p className="font-medium">{user.email} was deleted.</p>
        {warning ? (
          <p
            role="alert"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {warning}
          </p>
        ) : null}
      </div>
    );
  }

  const enabled = canDelete(user.email, typed) && !isPending;

  function onDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteUser(user.id);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setResult(res.result);
    });
  }

  return (
    <div className="space-y-4 rounded-md border border-red-200 bg-red-50 px-4 py-4 dark:border-red-900 dark:bg-red-950">
      <div>
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">Delete this user</p>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          This is irreversible and there is no grace period. Their data is deleted permanently, and
          any groups they own transfer immediately to the new owners listed above.
        </p>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="text-red-800 dark:text-red-300">
          Type <span className="font-mono">{user.email}</span> to confirm
        </span>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-md border border-red-300 bg-background px-3 font-mono text-sm dark:border-red-800"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={!enabled}
        onClick={onDelete}
        className="h-9 rounded-md bg-red-700 px-4 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Deleting…" : "Delete permanently"}
      </button>
    </div>
  );
}
