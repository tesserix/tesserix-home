"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, CalloutDescription, Input } from "@tesserix/web";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import type { SuppressionRow } from "@/lib/db/crm-repo";
import { addSuppressionAction, removeSuppressionAction } from "./actions";

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout role="alert" variant="destructive" className="mt-2">
      <CalloutDescription>{message}</CalloutDescription>
    </Callout>
  );
}

/**
 * Add a name to the do-not-contact list.
 *
 * At least one of email/instagram is required — the same
 * `crm_suppression_has_a_key` CHECK the database enforces — checked here so
 * an operator sees the reason before submitting rather than after a round
 * trip.
 */
function AddSuppressionForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hasKey = email.trim().length > 0 || instagramHandle.trim().length > 0;
  const canSubmit = hasKey && reason.trim().length > 0 && !pending;

  const submit = () => {
    if (!hasKey) {
      setError("Enter an email or an Instagram handle.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await addSuppressionAction({
        email: email.trim() || undefined,
        instagramHandle: instagramHandle.trim() || undefined,
        reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEmail("");
      setInstagramHandle("");
      setReason("");
      router.refresh();
    });
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="suppression-email">
          Email
        </label>
        <Input
          id="suppression-email"
          className="mt-1 h-9"
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="ava@example.com"
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="suppression-handle">
          Instagram handle
        </label>
        <Input
          id="suppression-handle"
          className="mt-1 h-9"
          value={instagramHandle}
          disabled={pending}
          onChange={(event) => setInstagramHandle(event.target.value)}
          placeholder="@bondibaker"
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="suppression-reason">
          Reason
        </label>
        <Input
          id="suppression-reason"
          className="mt-1 h-9"
          value={reason}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Asked not to be contacted"
        />
      </div>
      <Button type="submit" size="sm" disabled={!canSubmit}>
        {pending ? "Adding…" : "Add"}
      </Button>
      <ErrorNote message={error} />
    </form>
  );
}

function SuppressionRowItem({ suppression }: { suppression: SuppressionRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeSuppressionAction(suppression.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <li className="border-t border-border py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap gap-3">
            {suppression.email ? <span className="font-medium">{suppression.email}</span> : null}
            {suppression.instagramHandle ? (
              <span className="font-medium">{suppression.instagramHandle}</span>
            ) : null}
          </div>
          <div className="mt-1 text-muted-foreground">
            {suppression.reason} · added by {suppression.createdBy} on{" "}
            {new Date(suppression.createdAt).toLocaleDateString()}
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={remove}>
          {pending ? "Removing…" : "Remove"}
        </Button>
      </div>
      <ErrorNote message={error} />
    </li>
  );
}

export function SuppressionsView({
  suppressions,
  state,
  emptyMessage,
}: {
  suppressions: readonly SuppressionRow[];
  state: SurfaceState;
  emptyMessage: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <AddSuppressionForm />
      {state.kind === "ready" ? (
        <ul className="flex flex-col">
          {suppressions.map((suppression) => (
            <SuppressionRowItem key={suppression.id} suppression={suppression} />
          ))}
        </ul>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} />
      )}
    </div>
  );
}
