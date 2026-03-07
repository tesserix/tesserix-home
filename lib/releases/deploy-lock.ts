/**
 * Deploy lock state management.
 *
 * Uses in-memory store for now. In production with multiple instances,
 * migrate to GCS object or a database table.
 *
 * Lock state is per-service and includes who locked it and when.
 */

export interface DeployLock {
  serviceName: string;
  lockedBy: string;
  lockedAt: string;
  reason: string;
}

// In-memory store — survives across requests within the same process
const locks = new Map<string, DeployLock>();

export function getLock(serviceName: string): DeployLock | null {
  return locks.get(serviceName) ?? null;
}

export function getAllLocks(): DeployLock[] {
  return Array.from(locks.values());
}

export function setLock(
  serviceName: string,
  lockedBy: string,
  reason: string
): DeployLock {
  const lock: DeployLock = {
    serviceName,
    lockedBy,
    lockedAt: new Date().toISOString(),
    reason,
  };
  locks.set(serviceName, lock);
  return lock;
}

export function removeLock(serviceName: string): boolean {
  return locks.delete(serviceName);
}

export function isLocked(serviceName: string): boolean {
  return locks.has(serviceName);
}
