"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { v7 as uuidv7 } from "uuid";
import {
  readRecoveryRetry,
  writeRecoveryRetry,
  subscribeRecoveryRetry,
  recoveryDigest,
} from "@/lib/provisioning/recovery-retry";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/provisioning/api";
import type { StaffIdentityRecoveryRequestReceipt } from "@/lib/provisioning/generated/staff-recovery";
import { Button, Card, ErrorNote, Field, inputClass } from "./ui";

type HeldDecision = {
  key: string;
  digest: string;
  decision: "approved" | "rejected";
  successor?: string;
};
const uuidv7Pattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function parse(raw: string | null): HeldDecision | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid");
  const x = value as Record<string, unknown>;
  if (
    typeof x.key !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(x.key) ||
    typeof x.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.digest) ||
    (x.decision !== "approved" && x.decision !== "rejected") ||
    (x.successor !== undefined &&
      (typeof x.successor !== "string" || !uuidv7Pattern.test(x.successor)))
  )
    throw new Error("invalid");
  return x as HeldDecision;
}

export function RecoveryDecision({
  review,
  base,
  operator,
  onCommitted,
  onDenied,
}: {
  review: StaffIdentityRecoveryRequestReceipt;
  base: string;
  operator: { subject: string; sessionKey: string };
  onCommitted: () => void;
  onDenied: () => void;
}) {
  const storageKey = `staff-recovery:${operator.sessionKey}:${review.tenant_id}:${review.command_id}:${review.request_id}:decision`;
  const raw = useSyncExternalStore(
    subscribeRecoveryRetry,
    () => readRecoveryRetry(storageKey),
    () => null,
  );
  let pending: HeldDecision | null = null;
  let invalid = false;
  try {
    pending = parse(raw);
  } catch {
    invalid = true;
  }
  const [frozen, setFrozen] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [decision, setDecision] = useState("approved");
  const save = (value: HeldDecision | null) =>
    writeRecoveryRetry(storageKey, value);
  const fail = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "Decision unavailable");
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
      onDenied();
  };
  const finish = () => {
    save(null);
    setFrozen(null);
    setDone(true);
    onCommitted();
  };
  async function send(body: Record<string, string>, held: HeldDecision) {
    const result = await apiFetch<StaffIdentityRecoveryRequestReceipt>(
      `${base}/requests/${review.request_id}/decision`,
      { method: "PUT", body, idempotencyKey: held.key },
    );
    const d = result.decision;
    if (
      result.schema_version !== 1 ||
      result.tenant_id !== review.tenant_id ||
      result.command_id !== review.command_id ||
      result.request_id !== review.request_id ||
      d?.reviewed_by !== operator.subject ||
      d.decision !== body.decision ||
      d.reason !== body.reason ||
      (d.successor_command_id ?? undefined) !== held.successor
    )
      throw new Error(
        "The returned decision did not match this frozen request. Resume the retained request before retrying.",
      );
    finish();
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || invalid) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const fields = new FormData(event.currentTarget);
      const choice = pending?.decision ?? String(fields.get("decision"));
      const reason = String(fields.get("reason") ?? "");
      if (
        !reason.trim() ||
        Array.from(reason).length > 2000 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(reason) ||
        fields.get("acknowledged") !== "on"
      )
        throw new Error(
          "A review reason and independent evidence confirmation are required.",
        );
      const successor =
        pending?.successor ??
        (choice === "approved" && review.requested_action === "replace"
          ? uuidv7()
          : undefined);
      const body = {
        decision: choice,
        reason,
        ...(successor ? { successor_command_id: successor } : {}),
      };
      const bodyDigest = await recoveryDigest(body);
      if (pending && pending.digest !== bodyDigest)
        throw new Error(
          "Re-enter the original decision and reason. This request has an unconfirmed outcome.",
        );
      const held = pending ?? {
        key: newIdempotencyKey(),
        digest: bodyDigest,
        decision: choice as HeldDecision["decision"],
        ...(successor ? { successor } : {}),
      };
      save(held);
      setFrozen(body);
      await send(body, held);
    } catch (cause) {
      fail(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function retry() {
    if (!pending || !frozen || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await send(frozen, pending);
    } catch (cause) {
      fail(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function confirmRetained() {
    if (!pending || !review.decision || inFlight.current) return;
    setError(null);
    const d = review.decision;
    const body = {
      decision: d.decision,
      reason: d.reason,
      ...(d.successor_command_id
        ? { successor_command_id: d.successor_command_id }
        : {}),
    };
    if (
      d.reviewed_by !== operator.subject ||
      (await recoveryDigest(body)) !== pending.digest
    ) {
      setError(
        "The retained decision differs from this unconfirmed request. Preserve the request ID for investigation.",
      );
      return;
    }
    finish();
  }
  if (done)
    return <p role="status">Decision retained by the identity owner.</p>;
  if (review.decision && !pending && !invalid) return null;
  return (
    <Card
      title="Independent recovery decision"
      description="A decision is immutable. Approved replacement prepares a new command; it does not create or authorize an account."
    >
      <ErrorNote
        error={
          error ??
          (invalid
            ? "Saved retry metadata is unavailable or invalid. Resume the retained request before any new decision."
            : null)
        }
      />
      {pending && (
        <p className="mb-4 text-sm" role="status">
          Unconfirmed decision. The same request and retry key are retained.
          After reload, re-enter the original reason or confirm its retained
          outcome. Private reasons are not saved in browser storage.
        </p>
      )}
      {review.decision && pending ? (
        <Button onClick={() => void confirmRetained()}>
          Confirm retained decision
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset
            disabled={busy || invalid || !!(pending && frozen)}
            className="space-y-4"
          >
            <Field label="Review decision">
              <select
                name="decision"
                className={inputClass}
                value={pending?.decision ?? decision}
                disabled={!!pending}
                onChange={(event) => setDecision(event.target.value)}
              >
                <option value="approved">Approve recovery</option>
                <option value="rejected">Reject recovery</option>
              </select>
            </Field>
            <Field label="Review reason">
              <textarea
                name="reason"
                required
                maxLength={4000}
                className={`${inputClass} h-28`}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledged" required />I have
              independently reviewed the retained evidence
            </label>
            <Button type="submit">Record independent decision</Button>
          </fieldset>
          {pending && frozen && (
            <Button disabled={busy} onClick={() => void retry()}>
              Retry same decision
            </Button>
          )}
        </form>
      )}
    </Card>
  );
}
