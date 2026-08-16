// The ONE wire shape every product's audit normalises onto.
//
// It is `@tesserix/web`'s `AuditLogEntry` — the row type `AuditLogViewer`
// renders — re-exported rather than redeclared, because a second local copy is
// exactly how a renderer and its feed drift apart. The console's own
// `console_audit_log` (migration 0018) already stores these columns verbatim,
// so this is the shape on the wire, in the viewer, and in the table.
//
// NOTE the name collision: `@tesserix/homechef-shared` ALSO exports an
// `AuditLogEntry`, and it is a completely different shape (entityType/
// entityId/oldValue/newValue/createdAt). Anything importing both must alias.
// `sources.ts` does.
//
// NOTE also that `metadata` is a STRING, not an object. The viewer renders it
// as text; JSON-encoding happens here, once, at the boundary.
import type { AuditLogEntry } from "@tesserix/web";

export type { AuditLogEntry };

/**
 * Coerce whatever an upstream calls a timestamp into an ISO-8601 string.
 *
 * The three sources disagree: `node-postgres` hands back a `Date` for
 * `timestamptz` (mark8ly), while kora-api and homechef-api both serialise Go
 * `time.Time` as an ISO string. Previously this difference was invisible
 * because the row went straight into `NextResponse.json`, which stringifies a
 * Date for you — normalising by hand means doing it explicitly.
 *
 * An unrecognised value is stringified rather than replaced with "now" or the
 * epoch: a wrong timestamp on an audit row is a lie about when something
 * happened, and a visibly odd string is the lesser failure.
 */
export function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return String(value ?? "");
}

/**
 * Build the `target` field from an upstream's (type, id) pair.
 *
 * Returns `undefined` when there is nothing to say — `target` is optional in
 * the wire shape precisely so a source without one does not have to invent a
 * placeholder. Never emits a bare separator.
 */
export function joinTarget(
  type: string | null | undefined,
  id: string | null | undefined,
): string | undefined {
  const t = type?.trim() || undefined;
  const i = id?.trim() || undefined;
  if (t && i) return `${t}:${i}`;
  return t ?? i;
}

/**
 * JSON-encode the per-source extras that do not fit the six normalised fields
 * (severity, IP, before/after diffs...). Keys whose value is null/undefined/""
 * are dropped, and an entirely empty object yields `undefined` rather than the
 * string "{}" — the viewer shows `metadata` verbatim, and "{}" reads as data
 * where there is none.
 */
export function stringifyMetadata(
  extras: Readonly<Record<string, unknown>>,
): string | undefined {
  const kept = Object.entries(extras).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (kept.length === 0) return undefined;
  return JSON.stringify(Object.fromEntries(kept));
}

/** Newest first, with `id` as the tiebreak so a merged list has a stable order. */
export function byNewestFirst(a: AuditLogEntry, b: AuditLogEntry): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
