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
 * The source vocabulary. These ids are the ONE set of names for a source in
 * this response: they are the URL's `:product`, the key `fetchAuditSource`
 * dispatches on, the `source` on every entry, and the `source` in `failures[]`.
 *
 * They live here, beside the wire shape, rather than in `sources.ts`, because
 * `source` is now a field ON that shape — a consumer reading an entry needs the
 * vocabulary without needing the fetchers. `sources.ts` re-exports them so the
 * dispatch table's imports read the way they always did.
 */
export const AUDIT_PRODUCTS = ["mark8ly", "kora", "homechef"] as const;
export type AuditProduct = (typeof AUDIT_PRODUCTS)[number];

export function isAuditProduct(value: string): value is AuditProduct {
  return (AUDIT_PRODUCTS as readonly string[]).includes(value);
}

/**
 * An entry plus the source that produced it.
 *
 * `AuditLogEntry` is `@tesserix/web`'s and is EXTENDED here, never redeclared —
 * a merged entry is still exactly what `AuditLogViewer` accepts.
 *
 * As of `@tesserix/web` 1.13.0 the base type carries `source?: string` and the
 * viewer RENDERS it (design-system#12). This is no longer an extra field the
 * component ignores; the extension now only narrows it — from optional and any
 * string, to required and one of `AUDIT_PRODUCTS`. That narrowing is the part
 * worth keeping: the viewer tolerates a row with no source, and this wire shape
 * does not.
 *
 * Why the field has to exist at all: `/api/admin/apps/all/audit-logs` merges
 * three products into one list, and without this there is nothing on a row
 * saying which product it came from. On any other surface that is a missing
 * column; on an audit log it means "who did what" ships without "where", which
 * is not a whole answer. Downstream cannot recover it — the six normalised
 * fields are deliberately product-neutral, which is the point of normalising.
 */
export interface SourcedAuditLogEntry extends AuditLogEntry {
  readonly source: AuditProduct;
}

/**
 * The id namespace separator.
 *
 * Safe as a separator because no source id contains it (they are the closed
 * set above), so `${source}:${id}` parses back unambiguously at the first
 * colon even when a raw id contains colons of its own.
 */
const SOURCE_SEPARATOR = ":";

/** `mark8ly` + `9f2` -> `mark8ly:9f2`. The convention the console already uses. */
export function namespaceId(source: string, id: string): string {
  return `${source}${SOURCE_SEPARATOR}${id}`;
}

/**
 * Attribute one normalised row to the source that produced it.
 *
 * Does two things at once, deliberately, because they are the same fact: it
 * records the source AND namespaces the id with it.
 *
 * The id half is not cosmetic. mark8ly's ids are uuids but kora's and
 * homechef's are not guaranteed to be, so `12` from one product and `12` from
 * another are indistinguishable in a merged list — and `AuditLogViewer` keys
 * its list by `id`, so a collision is a mis-reconciled row in an audit log.
 * Namespacing here makes `id` unique across the merge BY CONSTRUCTION, at the
 * boundary where the source is known for certain, rather than by a downstream
 * guess about which row came from where.
 *
 * Immutable: returns a new row, never touches the one it was given.
 */
export function attributeTo(
  source: AuditProduct,
  entry: AuditLogEntry,
): SourcedAuditLogEntry {
  return { ...entry, source, id: namespaceId(source, entry.id) };
}

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
