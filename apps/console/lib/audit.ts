import { ESTATE } from "@tesserix/console-core";
// Imported from `./platform-api-error`, NOT from `./platform-api`. This module
// is reached from `"use client"` components, and `PlatformApiError` is a value
// (thrown, and narrowed with `instanceof`), so a value import of it from
// `./platform-api` is what dragged `pg` into the browser bundle and broke the
// production build. Point it back at `./platform-api` and it breaks again.
import { PlatformApiError } from "./platform-api-error";
// The console's own row shape, re-exported as THE shape of this surface.
//
// `import type` + `export type`, so nothing here pulls `pg` into a module that
// a client component transitively imports. The definition lives in
// `db/audit-repo.ts` because that is what writes the rows; a second copy here
// is exactly how a reader and its writer drift apart, and apps/web already
// learned that lesson (see its `lib/audit/entry.ts`).
//
// It is structurally `@tesserix/web`'s `AuditLogEntry` — the row type
// `AuditLogViewer` renders — which is also the wire shape apps/web's
// `/api/admin/apps/:product/audit-logs` normalises every product onto. One
// shape from three products' databases, through an HTTP boundary, into the
// component, with no mapping layer anywhere in between. That is the whole
// point of the #134 schema decision.
import type { AuditEntry } from "./db/audit-repo";

export type { AuditEntry };

/**
 * An entry plus the source that produced it — the shape this surface actually
 * merges and renders.
 *
 * `source` is REQUIRED. Every row on this surface has come from somewhere, and
 * an audit timeline that cannot attribute a row is missing the column an
 * operator most needs: "who did what" without "where" is not a whole answer.
 * The products' rows arrive with it already set by apps/web's normalisers; the
 * console's own rows get it from `withSource` below.
 *
 * Typed `string`, not `AuditSource`, on purpose. apps/web owns the product
 * list, and when a fourth product gains an audit trail its rows will arrive
 * here before this build knows the id. `sourceLabel` already renders an
 * unknown id verbatim rather than inventing a name, so an unrecognised source
 * degrades to "shown, honestly, under its raw id" — not to an unattributed row
 * or a parse failure.
 */
export interface SourcedAuditEntry extends AuditEntry {
  readonly source: string;
}

/**
 * The estate's audit timeline: reading it, and merging the sources honestly.
 *
 * Two sources feed this surface and they are not alike:
 *
 *   products — the platform API's `GET /v1/audit`, which fans out to every
 *              product declaring the audit contract and returns a partial
 *              result plus a per-source failure list. Until PLATFORM_API_ORIGIN
 *              is set this still comes from apps/web's aggregate endpoint; the
 *              wire shape is identical, which is why the cutover is one branch.
 *   console  — `console_audit_log`, the console's own operator actions, read
 *              straight from tesserix-postgres.
 *
 * The console's rows are ONE SOURCE AMONG SEVERAL, not a separate page. An
 * operator asking "who touched this" should not have to know which system
 * recorded the answer.
 */

/**
 * A source that could not be read, from the aggregate endpoint's `failures`.
 *
 * Same shape as `/admin/search`'s, deliberately. This is not decoration: an
 * audit timeline that silently omits a product is worse than one that says
 * "Kora unavailable", because a reader draws conclusions from what is NOT in
 * an audit log. Absence of evidence is the whole product here.
 */
export interface AuditSourceFailure {
  readonly source: string;
  readonly message: string;
}

/** The aggregate endpoint's body, narrowed to what this surface reads. */
export interface EstateAuditLog {
  readonly entries: readonly SourcedAuditEntry[];
  readonly failures: readonly AuditSourceFailure[];
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The console's own log, as a source id.
 *
 * Deliberately not one of apps/web's product ids: sending `?source=console` to
 * `/api/admin/apps/:product/audit-logs` is a 404 by design, and this surface
 * must never do it. `upstreamProductFor` below is what keeps the two
 * namespaces from mixing.
 */
export const CONSOLE_SOURCE = "console";

/**
 * The products whose audit trail the aggregate endpoint can actually reach.
 *
 * Hardcoded rather than derived from ESTATE, and that is the honest direction:
 * ESTATE lists seven products, four of which have no audit source at all.
 * Offering DevAI here would produce a 404 from a filter the operator was
 * invited to use. These three are what `AUDIT_PRODUCTS` in
 * `apps/web/lib/audit/sources.ts` supports; adding a fourth is a change there
 * first.
 */
export const AUDIT_PRODUCT_SOURCES = ["mark8ly", "kora", "homechef"] as const;

/** Every source this surface can show, console included. */
export const AUDIT_SOURCES = [
  ...AUDIT_PRODUCT_SOURCES,
  CONSOLE_SOURCE,
] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];

export function isAuditSource(value: string): value is AuditSource {
  return (AUDIT_SOURCES as readonly string[]).includes(value);
}

/**
 * Display name for a source id.
 *
 * Product names come from ESTATE so "homechef" renders as "Fe3dr" — the
 * context key and the product's name genuinely differ, and showing the key
 * would name a product nobody calls it. An id ESTATE does not know is returned
 * verbatim rather than prettified: the aggregate endpoint's `failures` can name
 * a source this build has never heard of, and inventing a label for it would
 * hide exactly the case worth seeing.
 */
export function sourceLabel(id: string): string {
  if (id === CONSOLE_SOURCE) return "Console";
  return ESTATE.find((product) => product.context === id)?.name ?? id;
}

/**
 * Which upstream product id a source filter maps to, or `null` when the
 * upstream must not be called at all.
 *
 * `null` for the console's own log is the point: filtering to `console` and
 * still calling the aggregate endpoint would render "Kora unavailable" on a
 * view that is not showing Kora.
 */
export function upstreamProductFor(source: AuditSource | null): string | null {
  if (source === null) return "all";
  if (source === CONSOLE_SOURCE) return null;
  return source;
}

/** Whether the console's own rows belong in a given source selection. */
export function includesConsoleSource(source: AuditSource | null): boolean {
  return source === null || source === CONSOLE_SOURCE;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function fail(message: string): never {
  throw new PlatformApiError(`audit log: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

/**
 * An optional text field. `null` is accepted as "absent" because that is what
 * a nullable column and a Go zero value both serialise to; anything else that
 * is not a string is a contract change and throws.
 */
function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function parseEntry(value: unknown, path: string): SourcedAuditEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    // Required, for the same reason `failures` is: a body without it is an
    // older apps/web that merged its products unattributed, and defaulting the
    // source to anything at all would put a label on rows whose origin this
    // surface does not know. A wrong Source column is worse than a failed read.
    source: str(row.source, `${path}.source`),
    id: str(row.id, `${path}.id`),
    actor: str(row.actor, `${path}.actor`),
    action: str(row.action, `${path}.action`),
    target: optionalStr(row.target, `${path}.target`),
    timestamp: str(row.timestamp, `${path}.timestamp`),
    metadata: optionalStr(row.metadata, `${path}.metadata`),
  };
}

/**
 * Parse the aggregate endpoint's body.
 *
 * Strict, like `lib/tickets.ts` and `lib/support-analytics.ts`: a renamed field
 * upstream must surface as a failure, not as a timeline quietly missing its
 * actors. An audit log that renders "undefined did something" is worse than one
 * that says it could not be read.
 *
 * `failures` is REQUIRED, not defaulted to `[]`. A body without it is either an
 * older deployment of apps/web or a different endpoint entirely, and in both
 * cases treating the absence as "no failures" would assert completeness this
 * surface cannot verify — the one claim it must never make by accident.
 */
export function parseEstateAuditLog(json: unknown): EstateAuditLog {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!Array.isArray(body.entries)) fail("entries is not an array");
  if (!Array.isArray(body.failures)) fail("failures is missing");

  const entries = body.entries.map((entry, i) => parseEntry(entry, `entries[${i}]`));
  const failures = body.failures.map((failure, i) => {
    const path = `failures[${i}]`;
    if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
      fail(`${path} is not an object`);
    }
    const row = failure as Record<string, unknown>;
    return {
      source: str(row.source, `${path}.source`),
      message: str(row.message, `${path}.message`),
    };
  });

  return { entries, failures };
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Attribute a source's rows to it: record the source, namespace the id with it.
 *
 * This is the console-side half of the convention apps/web's `attributeTo`
 * applies to the products' rows — same `${source}:${id}` shape, same reason.
 * `console_audit_log.id` is a plain sequence, so an un-namespaced `41` collides
 * with any integer id any product might have, and the list is keyed by `id`.
 *
 * It is applied HERE, at the read, rather than stored: migration 0018's columns
 * are deliberately `AuditLogEntry`-shaped, and every row in that table has the
 * same source. A stored column would be a constant repeated a million times.
 *
 * Only the console's own rows need this. The products' rows arrive already
 * sourced and already namespaced on BOTH transports — apps/web's `attributeTo`
 * (apps/web/lib/audit/entry.ts) does it at that app's boundary, and the
 * platform API's audit service does it at the same point, stamping `source`
 * and `${slug}:${id}` from the slug it called rather than from anything the
 * product's body claims. Doing it again here would produce
 * `product:mark8ly:9f2` and put "product" in the Source column of rows that
 * can name their actual product.
 *
 * Immutable: new rows, the input untouched.
 */
export function withSource(
  entries: readonly AuditEntry[],
  source: string,
): SourcedAuditEntry[] {
  return entries.map((entry) => ({ ...entry, source, id: `${source}:${entry.id}` }));
}

/** Newest first, `id` as the tiebreak so a merged list has a stable order. */
export function byNewestFirst(a: AuditEntry, b: AuditEntry): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Make every id unique, keeping the first occurrence untouched.
 *
 * KEPT DELIBERATELY, and demoted. It used to be the MECHANISM for cross-source
 * uniqueness, because nothing on the wire said which product a row came from.
 * Now that every row is namespaced with its source at the boundary that
 * produced it, a collision between two sources cannot happen by construction,
 * and this is a guard rather than a mechanism.
 *
 * It still earns its place, because one failure mode survives: a single source
 * repeating its own primary key. That is not hypothetical — kora-api's
 * `/v1/admin/events` and homechef's `/audit-logs` are both paginated reads over
 * an append-only table, and a page boundary crossed while rows are being
 * inserted is the classic way one row is returned twice. The cost is a `Set`;
 * the failure it catches is React silently reconciling two audit events into
 * one, which is a row disappearing from an integrity record with no error
 * anywhere.
 *
 * It only ever touches the DUPLICATE, so the id an operator would recognise
 * stays as it is, and the suffix marks the row that needed disambiguating.
 * Dropping the duplicate was the alternative and it is wrong here: two rows
 * that share an id are two events, and deleting one of them from an audit
 * timeline to keep React happy is the exact failure this surface exists to make
 * impossible.
 */
export function dedupeIds<T extends AuditEntry>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      return entry;
    }
    let suffix = 2;
    while (seen.has(`${entry.id}#${suffix}`)) suffix++;
    const id = `${entry.id}#${suffix}`;
    seen.add(id);
    return { ...entry, id };
  });
}

/**
 * Merge every source into one timeline: newest first, ids guaranteed unique.
 *
 * Sorted across sources rather than concatenated per source, because the whole
 * value of the surface is the interleaving — "the console granted access at
 * 09:02 and mark8ly recorded the export at 09:03" is a story that a
 * source-grouped list does not tell.
 */
export function mergeTimeline(
  ...sources: readonly (readonly SourcedAuditEntry[])[]
): SourcedAuditEntry[] {
  // `flat()` already returns a fresh array, so sorting in place mutates
  // nothing a caller handed in.
  return dedupeIds(sources.flat().sort(byNewestFirst));
}
