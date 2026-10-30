"use client";

import { RecoveryDecision } from "./RecoveryDecision";
import { RecoveryProposal } from "./RecoveryProposal";
import { useState, useCallback, useRef } from "react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/provisioning/api";
import { useApi } from "@/lib/provisioning/useApi";
import type {
  StaffIdentityReceipt,
  StaffIdentityRecoveryRequestReceipt,
  StaffIdentityRecoverySourceReceipt,
} from "@/lib/provisioning/generated/staff-recovery";
import { Button, Card, ErrorNote, Field, inputClass, PageTitle } from "./ui";

type Scope = { tenantId: string; commandId: string; requestId?: string };
type Operator = { subject: string; sessionKey: string; canWrite: boolean };
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuidv7 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function StaffRecovery({
  initialScope,
  operator,
}: {
  initialScope: Scope;
  operator: Operator;
}) {
  return (
    <RecoveryWorkspace
      key={`${operator.sessionKey}:${initialScope.tenantId}:${initialScope.commandId}:${initialScope.requestId ?? ""}`}
      scope={initialScope}
      operator={operator}
    />
  );
}

function RecoveryWorkspace({
  scope,
  operator,
}: {
  scope: Scope;
  operator: Operator;
}) {
  const validScope =
    uuid.test(scope.tenantId) &&
    uuidv7.test(scope.commandId) &&
    (!scope.requestId || uuidv7.test(scope.requestId));
  const base = validScope
    ? `/v1/orgs/${scope.tenantId}/staff-identities/${scope.commandId}/recovery`
    : null;
  const receipt = useApi<StaffIdentityReceipt>(base);
  const [requestId, setRequestId] = useState(scope.requestId);
  const onKnown = useCallback(
    (id: string) => {
      setRequestId(id);
      const query = new URLSearchParams({
        tenantId: scope.tenantId,
        commandId: scope.commandId,
        requestId: id,
      });
      window.history.replaceState(
        null,
        "",
        `/platform/provisioning/staff-recovery?${query}`,
      );
    },
    [scope.tenantId, scope.commandId],
  );
  const request = useApi<StaffIdentityRecoveryRequestReceipt>(
    base && requestId ? `${base}/requests/${requestId}` : null,
  );
  const [source, setSource] =
    useState<StaffIdentityRecoverySourceReceipt | null>(null);
  const [checking, setChecking] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const reconcileKey = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bound = (
    value: {
      schema_version: number;
      tenant_id: string;
      command_id: string;
    } | null,
  ) =>
    value?.schema_version === 1 &&
    value.tenant_id === scope.tenantId &&
    value.command_id === scope.commandId;
  const current =
    bound(receipt.data) && !receipt.error && !receipt.loading
      ? receipt.data
      : null;
  const review =
    bound(request.data) &&
    request.data?.request_id === requestId &&
    !request.error &&
    !request.loading
      ? request.data
      : null;
  const mismatch =
    (!receipt.error && receipt.data && !bound(receipt.data)) ||
    (!request.error &&
      request.data &&
      (!bound(request.data) || request.data.request_id !== requestId));
  const reauthorize = () => {
    setSource(null);
    setNotice(null);
    request.reload();
    receipt.reload();
  };
  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback);
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
      reauthorize();
  };
  async function inspect() {
    if (!base || checking) return;
    setSource(null);
    setError(null);
    setChecking(true);
    try {
      const result = await apiFetch<StaffIdentityRecoverySourceReceipt>(
        `${base}/observations`,
        { method: "POST" },
      );
      if (
        !bound(result) ||
        !["absent", "matching", "removed"].includes(
          result.source_disposition,
        ) ||
        !Number.isFinite(Date.parse(result.observed_at))
      )
        throw new Error("The source response did not match this command.");
      setSource(result);
    } catch (cause) {
      fail(cause, "Source unavailable");
    } finally {
      setChecking(false);
    }
  }
  async function reconcile() {
    if (
      !base ||
      !operator.canWrite ||
      !current ||
      source?.source_disposition !== "matching" ||
      checking ||
      reconciling
    )
      return;
    setSource(null);
    setError(null);
    setReconciling(true);
    reconcileKey.current ??= newIdempotencyKey();
    try {
      const result = await apiFetch<StaffIdentityReceipt>(
        `${base}/reconciliations`,
        { method: "POST", idempotencyKey: reconcileKey.current },
      );
      if (
        !bound(result) ||
        result.actor_subject !== current.actor_subject ||
        result.product_key !== current.product_key ||
        result.command_state !== "created" ||
        !result.user_id ||
        !result.created_at ||
        !Number.isFinite(Date.parse(result.created_at))
      )
        throw new Error("The creation receipt did not match this command.");
      setNotice(
        "Original creation evidence retained. No account or membership was created.",
      );
      receipt.reload();
    } catch (cause) {
      fail(cause, "Reconciliation unavailable");
    } finally {
      setReconciling(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageTitle
        title="Staff identity recovery"
        description="Inspect an exact identity command and its independently reviewed recovery evidence."
      />
      <Card title="Find retained evidence">
        <form
          method="get"
          action="/platform/provisioning/staff-recovery"
          className="grid gap-4 md:grid-cols-3"
        >
          <Field label="Tenant UUID">
            <input
              name="tenantId"
              required
              defaultValue={scope.tenantId}
              pattern={uuid.source}
              className={inputClass}
            />
          </Field>
          <Field label="Identity command UUIDv7">
            <input
              name="commandId"
              required
              defaultValue={scope.commandId}
              pattern={uuidv7.source}
              className={inputClass}
            />
          </Field>
          <Field label="Recovery request UUIDv7 (optional)">
            <input
              name="requestId"
              defaultValue={scope.requestId}
              pattern={uuidv7.source}
              className={inputClass}
            />
          </Field>
          <Button type="submit">Load retained evidence</Button>
        </form>
      </Card>
      <ErrorNote
        error={
          error ??
          receipt.error ??
          request.error ??
          (mismatch
            ? "The returned evidence did not match this tenant, command and request."
            : null)
        }
      />
      {notice && <p role="status">{notice}</p>}
      {base && receipt.loading && (
        <p role="status">Checking retained command…</p>
      )}
      {current && (
        <>
          <Card title="Identity command">
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt>Tenant</dt>
                <dd>{scope.tenantId}</dd>
              </div>
              <div>
                <dt>Command</dt>
                <dd>{scope.commandId}</dd>
              </div>
              <div>
                <dt>Command state</dt>
                <dd>{current.command_state}</dd>
              </div>
              <div>
                <dt>Recovery state</dt>
                <dd>
                  {current.recovery_state ?? "No final recovery decision"}
                </dd>
              </div>
              <div>
                <dt>Original initiator</dt>
                <dd>{current.actor_subject}</dd>
              </div>
              <div>
                <dt>Prepared at</dt>
                <dd>{current.prepared_at}</dd>
              </div>
            </dl>
          </Card>
          <Card
            title="Current source observation"
            description="A point-in-time observation. The owner checks the source again before an approval."
          >
            <Button
              disabled={checking || reconciling}
              onClick={() => void inspect()}
            >
              Check current source
            </Button>
            {source?.source_disposition === "matching" && operator.canWrite && (
              <div className="mt-3">
                <Button
                  disabled={checking || reconciling}
                  onClick={() => void reconcile()}
                >
                  Reconcile matching creation
                </Button>
              </div>
            )}
            {reconciling && (
              <p role="status">Retaining original creation evidence…</p>
            )}
            {checking && <p role="status">Checking source…</p>}
            {source && (
              <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <dt>Source disposition</dt>
                  <dd>{source.source_disposition}</dd>
                </div>
                <div>
                  <dt>Observed at</dt>
                  <dd>{source.observed_at}</dd>
                </div>
              </dl>
            )}
          </Card>
          {requestId && (
            <Button variant="secondary" onClick={() => request.reload()}>
              Refresh retained request
            </Button>
          )}
          {review && (
            <Card title="Retained recovery request">
              <dl className="grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <dt>Request</dt>
                  <dd>{review.request_id}</dd>
                </div>
                <div>
                  <dt>Requested action</dt>
                  <dd>{review.requested_action}</dd>
                </div>
                <div>
                  <dt>Requested by</dt>
                  <dd>{review.requested_by}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd className="whitespace-pre-wrap break-words">
                    {review.reason}
                  </dd>
                </div>
                <div>
                  <dt>Evidence reference</dt>
                  <dd className="break-words">{review.evidence_reference}</dd>
                </div>
                {review.replacement_actor_subject && (
                  <div>
                    <dt>Replacement initiator</dt>
                    <dd>{review.replacement_actor_subject}</dd>
                  </div>
                )}
                {review.decision && (
                  <>
                    <div>
                      <dt>Decision</dt>
                      <dd>{review.decision.decision}</dd>
                    </div>
                    <div>
                      <dt>Reviewed by</dt>
                      <dd>{review.decision.reviewed_by}</dd>
                    </div>
                    <div>
                      <dt>Review reason</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {review.decision.reason}
                      </dd>
                    </div>
                    {review.decision.successor_command_id && (
                      <div>
                        <dt>Prepared successor command</dt>
                        <dd>{review.decision.successor_command_id}</dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
            </Card>
          )}
          {operator.canWrite && base && (
            <RecoveryProposal
              base={base}
              tenantId={scope.tenantId}
              commandId={scope.commandId}
              operator={operator}
              review={review}
              requestId={requestId}
              allowNew={!scope.requestId}
              onKnown={onKnown}
              onDenied={reauthorize}
              onCommitted={() => {
                setNotice(
                  "Recovery request retained. A different operator must review it.",
                );
                request.reload();
                receipt.reload();
              }}
            />
          )}
          {review &&
            operator.canWrite &&
            ![
              review.requested_by,
              review.replacement_actor_subject,
              current.actor_subject,
              current.user_id,
            ].includes(operator.subject) &&
            base && (
              <RecoveryDecision
                review={review}
                base={base}
                operator={operator}
                onDenied={reauthorize}
                onCommitted={() => {
                  setNotice("Decision retained by the identity owner.");
                  request.reload();
                  receipt.reload();
                }}
              />
            )}
          {review &&
            operator.canWrite &&
            [
              review.requested_by,
              review.replacement_actor_subject,
              current.actor_subject,
              current.user_id,
            ].includes(operator.subject) && (
              <p role="status">
                An independent operator must review this request.
              </p>
            )}
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Recovery retains identity evidence and does not grant membership or
        hospital access. Employment, staff links and scoped permissions require
        their own current decisions.
      </p>
    </div>
  );
}
