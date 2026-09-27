function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery metadata");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error("Invalid recovery metadata");
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid recovery timestamp");
  return result;
}

function number(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error("Invalid recovery measurement");
  return value;
}

export type RecoveryOperation = "backup" | "restore-test";
export type RecoveryActionResult = { ok: boolean; message: string };

export function parseRecoveryJob(value: unknown) {
  const job = record(value);
  const name = text(job.name);
  if (!/^openbao-(verified-backup|restore-test)-[a-z0-9-]+$/.test(name)) throw new Error("Invalid recovery job");
  const operation = text(job.operation);
  if (operation !== "backup" && operation !== "restore-test") throw new Error("Invalid recovery operation");
  const phase = text(job.phase);
  if (!["Pending", "Running", "Completed", "Failed"].includes(phase)) throw new Error("Invalid recovery phase");
  return { name, operation, phase, createdAt: timestamp(job.createdAt), completedAt: job.completedAt === undefined ? undefined : timestamp(job.completedAt) };
}

export function parseRecoveryStatus(value: unknown) {
  const status = record(value);
  if (!Array.isArray(status.backups) || status.backups.length > 3 || !Array.isArray(status.jobs) || status.jobs.length > 20 || typeof status.jobsComplete !== "boolean") throw new Error("Invalid recovery status");
  const backups = status.backups.map((value: unknown) => {
    const backup = record(value);
    const id = text(backup.id);
    if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid backup identifier");
    const bytes = number(backup.bytes, 256 * 1024 * 1024);
    if (!Number.isInteger(bytes) || bytes < 1) throw new Error("Invalid snapshot size");
    return { id, created: timestamp(backup.created), bytes, restoreSeconds: number(backup.restoreSeconds, 900), openbaoVersion: text(backup.openbaoVersion, 64) };
  });
  if (new Set(backups.map((b) => b.id)).size !== backups.length) throw new Error("Duplicate backup identifier");
  return { backups, jobs: status.jobs.map(parseRecoveryJob), jobsComplete: status.jobsComplete };
}

export type RecoveryStatus = ReturnType<typeof parseRecoveryStatus>;
