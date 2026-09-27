import "server-only";

import { secretsRequest } from "./secrets-api";
import { parseRecoveryJob, parseRecoveryStatus, type RecoveryOperation } from "./recovery";

export async function fetchRecoveryStatus() {
  const status = parseRecoveryStatus(await secretsRequest("Recovery status", "/api/recovery", { signal: AbortSignal.timeout(20_000) }));
  const latest = status.backups[0];
  return { ...status, stale: !latest || Date.now() - Date.parse(latest.created) > 14 * 60 * 60 * 1000 };
}

export async function startRecoveryOperation(operation: RecoveryOperation, idempotencyKey: string) {
  return parseRecoveryJob(await secretsRequest("Start recovery operation", "/api/recovery/jobs", {
    method: "POST", body: { operation, idempotencyKey }, signal: AbortSignal.timeout(20_000),
  }));
}
