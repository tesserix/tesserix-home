"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { v7 as uuidv7 } from "uuid";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/provisioning/api";
import {
  readRecoveryRetry,
  writeRecoveryRetry,
  subscribeRecoveryRetry,
  recoveryDigest,
} from "@/lib/provisioning/recovery-retry";
import type {
  StaffIdentityRecoveryProposalReceipt,
  StaffIdentityRecoveryRequestReceipt,
} from "@/lib/provisioning/generated/staff-recovery";
import { Button, Card, ErrorNote, Field, inputClass } from "./ui";

type HeldProposal = {
  key: string;
  digest: string;
  requestId: string;
  action: "close_unresolved" | "replace";
};
const uuidv7Pattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function parse(raw: string | null): HeldProposal | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid");
  const x = value as Record<string, unknown>;
  if (
    typeof x.key !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(x.key) ||
    typeof x.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.digest) ||
    typeof x.requestId !== "string" ||
    !uuidv7Pattern.test(x.requestId) ||
    (x.action !== "close_unresolved" && x.action !== "replace")
  )
    throw new Error("invalid");
  return x as HeldProposal;
}

export function RecoveryProposal({
  base,
  tenantId,
  commandId,
  operator,
  review,
  requestId,
  allowNew,
  onKnown,
  onCommitted,
  onDenied,
}: {
  base: string;
  tenantId: string;
  commandId: string;
  operator: { subject: string; sessionKey: string };
  review: StaffIdentityRecoveryRequestReceipt | null;
  requestId?: string;
  allowNew: boolean;
  onKnown: (request: string) => void;
  onCommitted: () => void;
  onDenied: () => void;
}) {
  const storageKey = `staff-recovery:${operator.sessionKey}:${tenantId}:${commandId}:proposal`;
  const raw = useSyncExternalStore(
    subscribeRecoveryRetry,
    () => readRecoveryRetry(storageKey),
    () => null,
  );
  let pending: HeldProposal | null = null;
  let invalid = false;
  try {
    pending = parse(raw);
  } catch {
    invalid = true;
  }
  const pendingId = pending?.requestId;
  useEffect(() => {
    if (pendingId && (!requestId || requestId === pendingId))
      onKnown(pendingId);
  }, [pendingId, requestId, onKnown]);
  const [frozen, setFrozen] = useState<Record<string, string> | null>(null);
  const [action, setAction] = useState("close_unresolved");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fail = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "Proposal unavailable");
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
      onDenied();
  };
  const finish = () => {
    writeRecoveryRetry(storageKey, null);
    setFrozen(null);
    setDone(true);
    onCommitted();
  };
  async function send(body: Record<string, string>, held: HeldProposal) {
    const result = await apiFetch<StaffIdentityRecoveryProposalReceipt>(
      `${base}/requests/${held.requestId}`,
      { method: "PUT", body, idempotencyKey: held.key },
    );
    if (
      result.schema_version !== 1 ||
      result.tenant_id !== tenantId ||
      result.command_id !== commandId ||
      result.request_id !== held.requestId ||
      result.requested_action !== held.action
    )
      throw new Error(
        "The proposal receipt did not match this frozen request. Resume its exact request ID before retrying.",
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
      const requested =
        pending?.action ?? String(fields.get("requested_action"));
      const reason = String(fields.get("reason") ?? "");
      const evidence = String(fields.get("evidence_reference") ?? "");
      const replacement = String(fields.get("replacement_actor_subject") ?? "");
      if (
        !reason.trim() ||
        Array.from(reason).length > 2000 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(reason) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(evidence) ||
        (requested === "replace" && !/^[A-Za-z0-9_-]{1,200}$/.test(replacement))
      )
        throw new Error(
          "A valid reason, evidence reference and required replacement initiator are needed.",
        );
      const body = {
        requested_action: requested,
        reason,
        evidence_reference: evidence,
        ...(requested === "replace"
          ? { replacement_actor_subject: replacement }
          : {}),
      };
      const bodyDigest = await recoveryDigest(body);
      if (pending && pending.digest !== bodyDigest)
        throw new Error(
          "Re-enter the original proposal fields. This request has an unconfirmed outcome.",
        );
      const held = pending ?? {
        key: newIdempotencyKey(),
        requestId: uuidv7(),
        digest: bodyDigest,
        action: requested as HeldProposal["action"],
      };
      writeRecoveryRetry(storageKey, held);
      setFrozen(body);
      onKnown(held.requestId);
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
    if (!pending || !review) return;
    const body = {
      requested_action: review.requested_action,
      reason: review.reason,
      evidence_reference: review.evidence_reference,
      ...(review.replacement_actor_subject
        ? { replacement_actor_subject: review.replacement_actor_subject }
        : {}),
    };
    if (
      review.requested_by !== operator.subject ||
      review.request_id !== pending.requestId ||
      (await recoveryDigest(body)) !== pending.digest
    ) {
      setError(
        "The retained proposal differs from this unconfirmed request. Preserve its ID for investigation.",
      );
      return;
    }
    finish();
  }
  if (done || (!pending && !invalid && (review || !allowNew))) return null;
  if (pending && requestId && pending.requestId !== requestId)
    return (
      <p role="alert">
        An unconfirmed proposal exists for request {pending.requestId}. Open
        that exact request before creating another.
      </p>
    );
  return (
    <Card
      title="Propose identity recovery"
      description="Retain the investigation and request independent review. No identity is created or granted access by this proposal."
    >
      <ErrorNote
        error={
          error ??
          (invalid
            ? "Saved retry metadata is unavailable or invalid. Resume the retained request before creating another."
            : null)
        }
      />
      {pending && (
        <p role="status" className="mb-4 text-sm">
          Unconfirmed proposal {pending.requestId}. Retry the same input or
          confirm its retained outcome. Private reasons and evidence references
          are not saved in browser storage.
        </p>
      )}
      {pending && review ? (
        <Button onClick={() => void confirmRetained()}>
          Confirm retained proposal
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset
            disabled={busy || invalid || !!(pending && frozen)}
            className="space-y-4"
          >
            <Field label="Requested recovery action">
              <select
                className={inputClass}
                name="requested_action"
                value={pending?.action ?? action}
                disabled={!!pending}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="close_unresolved">
                  Close unresolved investigation
                </option>
                <option value="replace">Prepare reviewed replacement</option>
              </select>
            </Field>
            {(pending?.action ?? action) === "replace" && (
              <Field label="Replacement initiator subject">
                <input
                  required
                  name="replacement_actor_subject"
                  maxLength={200}
                  pattern="[A-Za-z0-9_-]{1,200}"
                  className={inputClass}
                />
              </Field>
            )}
            <Field label="Proposal reason">
              <textarea
                required
                name="reason"
                maxLength={4000}
                className={`${inputClass} h-28`}
              />
            </Field>
            <Field label="Evidence reference">
              <input
                required
                name="evidence_reference"
                maxLength={200}
                pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}"
                className={inputClass}
              />
            </Field>
            <Button type="submit">Record recovery request</Button>
          </fieldset>
          {pending && frozen && (
            <Button disabled={busy} onClick={() => void retry()}>
              Retry same proposal
            </Button>
          )}
        </form>
      )}
    </Card>
  );
}
