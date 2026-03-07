/**
 * Release event recording.
 *
 * In-memory store for now — records promote, rollback, lock, unlock events.
 * Events survive across requests within the same process.
 * For multi-instance persistence, migrate to audit-service or GCS.
 */

import type { ReleaseAction } from "@/lib/api/releases";

export interface ReleaseEvent {
  id: string;
  action: ReleaseAction;
  serviceName: string;
  serviceDisplayName: string;
  fromVersion?: string;
  toVersion?: string;
  triggeredBy: string;
  timestamp: string;
  pipelineUrl?: string;
}

const MAX_EVENTS = 200;
const events: ReleaseEvent[] = [];

let nextId = 1;

function generateId(): string {
  return `evt_${Date.now()}_${nextId++}`;
}

export function recordEvent(
  action: ReleaseAction,
  serviceName: string,
  serviceDisplayName: string,
  opts: {
    fromVersion?: string;
    toVersion?: string;
    triggeredBy?: string;
    pipelineUrl?: string;
  } = {}
): ReleaseEvent {
  const event: ReleaseEvent = {
    id: generateId(),
    action,
    serviceName,
    serviceDisplayName,
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    triggeredBy: opts.triggeredBy ?? "admin",
    timestamp: new Date().toISOString(),
    pipelineUrl: opts.pipelineUrl,
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  return event;
}

export function getEvents(limit = 50): ReleaseEvent[] {
  return events.slice(0, limit);
}
