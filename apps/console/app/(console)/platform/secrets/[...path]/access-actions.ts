"use server";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { auditedOperation, type AuditDescription } from "@/lib/db/audit-repo";
import {
  createGrant,
  deleteSecret,
  restoreSecretVersion,
  revokeGrant,
  type AppRef,
} from "@/lib/secrets-api";
import type { SecretStore } from "@/lib/secrets";
import { PlatformApiError } from "@/lib/platform-api-error";

/**
 * Grant and revoke a secret reader — the server-action boundary
 * `access-panel.tsx` (task 4) calls across, mirroring `draft-editor.tsx`'s
 * relationship to `billing/catalog/actions.ts`.
 *
 * # WHY THIS FILE GATES, AND `./actions.ts` DOES NOT
 *
 * `./actions.ts`'s `writeSecretAction` carries a DELIBERATE EXCEPTION: it
 * calls neither `checkOperatorCapability` nor `checkOperatorCapabilityLive`,
 * because `secrets-api` itself refuses `PUT /api/secrets/*path` on the
 * OPERATOR'S OWN Zitadel token, and a console-side check would be a
 * duplicate of that gate, not a second layer of defence.
 *
 * The actions here are different in the one respect that matters: they do
 * not write a value into an existing store the way a secret write does —
 * `createGrant`/`revokeGrant` call `bao.GrantAll`/its inverse, which change
 * `tesserix-k8s`, the repository that governs the cluster, IMMEDIATELY (the
 * pull request `secrets-api` opens afterwards is a receipt, not an approval
 * gate — see `createGrant`'s own doc comment in `lib/secrets-api.ts`). The
 * cutover design's §4 puts approval "in application code" for exactly this
 * class of change and says it "gets the platform API's treatment: refuse by
 * default, no fallback that silently allows." That is a property of THIS
 * write — reaching outside the secret store into the cluster's own
 * repository — not a general "writes should be gated" rule; the sibling
 * file's non-gate is not an oversight this file is correcting.
 *
 * So these gate console-side with `checkOperatorCapabilityLive`, on the same
 * two capabilities `secrets-api`'s `live` route group requires: `platform`
 * (the surface) and `rotate-credentials` (the risk verb) — see
 * `createGrant`/`revokeGrant`'s own doc comments for that requirement.
 * Checked in addition to each other, never as alternatives, the same
 * `withPublishWrite` checks `billing` and `publish-catalog` both.
 *
 * # THE AUDITED SHAPE, NOT THE THIN ONE
 *
 * `lib/tools-write.ts`'s `withToolsWrite` checks the capability BEFORE
 * calling `run()`, with no audit at all — correct for tools, where the Go
 * write records its own audit row inside the same transaction. There is no
 * such row here: `secrets-api` does not audit a grant/revoke to this
 * console's `console_audit_log`, so if this file did not audit it, nothing
 * would. It follows `billing/catalog/actions.ts`'s `withDraftWrite`/
 * `withPublishWrite` instead — the capability check runs INSIDE
 * `auditedOperation`'s `operation` callback, not before it, so a
 * `CapabilityError` reaches `auditedOperation` and is written as a
 * `capability.refused` row instead of vanishing before the audit path is
 * ever entered. A refused attempt to grant a reader on a secret is precisely
 * the thing an audit log exists to hold.
 */
export type SecretsWriteResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

// Named by the capabilities the operator lacks, not by whichever of the
// five operations `withAccessWrite` wraps was attempted (grant, revoke,
// delete, destroy, restore) — all five need the SAME PAIR of capabilities
// (`platform` and `rotate-credentials`, checked below), so naming both here
// stays true as more callers join `withAccessWrite` and never needs a
// per-operation update the way a message like "change who can read this
// secret" would have (that sentence was accurate for grant/revoke and wrong
// for delete/destroy/restore, which is how tesserix-home#495 happened).
// Naming only one of the two capabilities would repeat that mistake at a
// narrower grain: `checkOperatorCapabilityLive` checks `platform` first, so
// an operator who fails on `platform` alone (e.g. a live-revoked platform
// grant, see #285) would be told about `rotate-credentials`, which they may
// well still hold — an untrue message about which capability is missing.
const NO_PERMISSION_MESSAGE =
  "You don't have the platform and rotate-credentials capabilities this needs.";

/**
 * Internal error text (a transport failure, a non-2xx status, a body that
 * was not JSON) must never reach the operator verbatim — the same
 * discipline `withDraftWrite` and `withToolsWrite` apply. A `PlatformApiError`
 * 403 is folded into {@link NO_PERMISSION_MESSAGE}: to the operator, the
 * console refusing and secrets-api refusing are the same fact ("you may not
 * do this"), and showing two different sentences for it would teach them a
 * distinction that does not exist on their side of the boundary.
 */
const NOT_SAVED_MESSAGE = "That change was not saved.";

function isForbidden(cause: unknown): boolean {
  return cause instanceof PlatformApiError && cause.status === 403;
}

async function withAccessWrite<T>(
  target: string,
  run: () => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = session?.sub ?? "unknown";
    const value = await auditedOperation({
      actor,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "platform");
        await checkOperatorCapabilityLive(session, "rotate-credentials");
        return run();
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError || isForbidden(cause)) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // Anything else — secrets-api unreachable, a non-403 status, a body that
    // was not JSON, `AuditUnavailableError`/`AuditWriteError` — degrades to
    // the same fixed sentence. None of those are things an operator can act
    // on, and the underlying `cause.message` (which can carry secrets-api's
    // origin, a status code, or a database detail) is never shown.
    return { ok: false, message: NOT_SAVED_MESSAGE };
  }
}

/**
 * Grant `serviceAccount` a reader on `namespace`/`app`'s secret prefix.
 * `createGrant`'s `ttl` is left unset — the estate's cutover design has no
 * surface yet for choosing one, so every console-issued grant is
 * non-expiring until that lands.
 */
export async function grantAccessAction(input: {
  namespace: string;
  app: string;
  serviceAccount: string;
}): Promise<SecretsWriteResult> {
  const appRef: AppRef = {
    namespace: input.namespace,
    name: input.app,
    serviceAccount: input.serviceAccount,
  };
  const target = `${input.namespace}/${input.app}`;
  const result = await withAccessWrite(
    target,
    () => createGrant(appRef),
    () => ({ action: "secrets.access.grant", summary: { granted: 1 }, target }),
  );
  if (!result.ok) return result;
  return { ok: true };
}

/** Revoke `app`'s reader grant in `namespace`. */
export async function revokeAccessAction(namespace: string, app: string): Promise<SecretsWriteResult> {
  const target = `${namespace}/${app}`;
  const result = await withAccessWrite(
    target,
    () => revokeGrant(namespace, app),
    () => ({ action: "secrets.access.revoke", summary: { revoked: 1 }, target }),
  );
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * Delete (soft, reversible via `restoreSecretVersion`) or destroy
 * (permanent) the secret at `path`. Same gate as grant/revoke — `deleteSecret`
 * hits the same `secrets-api` `live` route group, so it needs `platform` +
 * `rotate-credentials` too (see `deleteSecret`'s own doc comment in
 * `lib/secrets-api.ts`).
 *
 * `destroy` reaches `deleteSecret` exactly as given — this action makes no
 * decision of its own about which lifecycle operation to call, only about
 * whether the caller is allowed to call either one. The typed-name
 * confirmation that makes destroy hard to trigger by accident lives entirely
 * client-side, in `destroy-secret.tsx` — this boundary trusts its caller the
 * same way `writeSecretAction` trusts the version it is handed.
 */
export async function deleteSecretAction(
  store: SecretStore,
  path: string,
  destroy: boolean,
): Promise<SecretsWriteResult> {
  const result = await withAccessWrite(
    path,
    () => deleteSecret(store, path, destroy),
    () => ({
      action: destroy ? "secrets.destroy" : "secrets.delete",
      summary: destroy ? { destroyed: 1, deleted: 0 } : { destroyed: 0, deleted: 1 },
      target: path,
    }),
  );
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * Restore a soft-deleted version of the secret at `path` — the operation the
 * Delete tab's copy already promises ("It stays recoverable — restore it
 * from the Versions tab"). Same gate as delete/destroy, for the same reason:
 * `restoreSecretVersion` hits `secrets-api`'s `live` route group (`POST
 * /api/secret-versions/*path`), which requires `platform` +
 * `rotate-credentials`.
 *
 * Only a delete can be reversed. A destroyed version is gone for good and
 * `secrets-api`'s `Restore` handler says so through the store's own error
 * rather than pretending otherwise — which is why `restore-version.tsx`
 * never offers the control for a destroyed version. This boundary does not
 * re-derive that decision: it is handed one version number and has no
 * version list to check it against, so it trusts its caller exactly the way
 * `deleteSecretAction` trusts the `destroy` flag it is handed. A restore
 * that reaches here for a destroyed version fails at `secrets-api` and
 * surfaces as {@link NOT_SAVED_MESSAGE}.
 */
export async function restoreSecretVersionAction(
  store: SecretStore,
  path: string,
  version: number,
): Promise<SecretsWriteResult> {
  const result = await withAccessWrite(
    path,
    () => restoreSecretVersion(store, path, version),
    // `restored: 1` is the count, matching `deleteSecretAction`'s
    // `{destroyed, deleted}` counters; `version` names WHICH one, which a
    // grant/revoke/delete row has no equivalent of because those act on the
    // secret rather than on one version of it.
    () => ({ action: "secrets.restore", summary: { restored: 1, version }, target: path }),
  );
  if (!result.ok) return result;
  return { ok: true };
}
