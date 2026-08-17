"use client";

/**
 * Renders an audit row's `metadata` for `AuditLogViewer`'s `renderMetadata`.
 *
 * WHAT IT IS FIXING. `metadata` is a JSON object serialised to a string —
 * that is the wire shape, set by `stringifyMetadata` in apps/web and by
 * `serialiseSummary` in `db/audit-repo`. Until now the viewer printed it
 * verbatim, so a mark8ly row read
 *
 *     {"severity":"critical","status":"success","tenant":"acme","ip":"10.0.0.1"}
 *
 * beside the actor. That is data an operator has to parse braces out of on a
 * surface whose whole job is being readable under pressure.
 *
 * THE RULE: EVERY KEY IS SHOWN. Nothing is dropped, nothing is truncated, no
 * key is filtered by a whitelist. That is deliberate and it is the constraint
 * that shapes the rest of this file — a formatter that hides part of an audit
 * record is worse than the braces, because the braces at least never lied
 * about how much there was. It also has to be true of keys this build has
 * never heard of: mark8ly spreads `...row.metadata` into its object, so
 * arbitrary per-event keys arrive here, and a whitelist would silently swallow
 * exactly the unusual field worth reading.
 *
 * So no subset, and therefore no "and N more" affordance to build.
 *
 * KEYS ARE RENDERED VERBATIM, not title-cased or prettified, for the same
 * reason `sourceLabel` returns an unknown source id unchanged: the key is what
 * the source recorded, and inventing a display name for `ip_address` or for
 * some key added upstream last week means the surface and the record disagree.
 *
 * VALUES. Primitives render as themselves. Objects and arrays — kora's and
 * homechef's `before`/`after` diffs are both — render as compact JSON, which
 * is what they rendered as before, only now behind their own label instead of
 * nested inside one undifferentiated blob. Deliberately NOT truncated: a
 * clipped diff is a diff that reads as complete and is not.
 *
 * NOT-JSON FALLS BACK TO VERBATIM. If the string does not parse, or parses to
 * something that is not a plain object, it is rendered exactly as it arrived.
 * A formatter is the wrong place to discover that a producer changed shape,
 * and showing the operator the raw record is the honest failure mode.
 */

/** One `key value` pair as it will be rendered. */
export interface MetadataField {
  readonly key: string;
  readonly value: string;
}

/**
 * Parse `metadata` into its fields, or `null` when it is not a JSON object.
 *
 * `null` is the caller's signal to render the raw string verbatim. Note that
 * JSON `null` and arrays both take that path: `typeof null === "object"` and
 * an array is an object, so both are excluded explicitly. Neither is a shape
 * any producer emits, and guessing at how to label one would be inventing a
 * reading of an audit record.
 */
export function parseMetadataFields(metadata: string): MetadataField[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const fields = Object.entries(parsed as Record<string, unknown>).map(
    ([key, value]) => ({ key, value: formatValue(value) }),
  );

  // `{}` parses fine and yields nothing to show. `stringifyMetadata` returns
  // `undefined` rather than "{}" precisely so this should not happen, but a
  // producer that regresses should not render an empty strip of nothing —
  // fall back to verbatim so the operator sees what actually arrived.
  return fields.length === 0 ? null : fields;
}

/**
 * A value as text.
 *
 * `JSON.stringify` for objects and arrays rather than `String(value)`, which
 * renders every object as "[object Object]" — the one formatting that destroys
 * the content outright.
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The rendered metadata.
 *
 * A `<dl>` because that is what this is — a list of key/value pairs — and it
 * gives a screen reader the pairing for free, where a run of styled spans
 * would read as one undifferentiated sentence.
 */
export function AuditMetadata({ metadata }: { metadata: string }) {
  const fields = parseMetadataFields(metadata);

  if (fields === null) {
    return <span>{metadata}</span>;
  }

  return (
    <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      {fields.map((field) => (
        <div key={field.key} className="flex items-baseline gap-1">
          <dt className="font-medium">{field.key}</dt>
          <dd className="break-all">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
