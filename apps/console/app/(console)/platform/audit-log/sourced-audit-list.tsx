"use client";

import { Badge } from "@tesserix/web";
import { sourceLabel, type SourcedAuditEntry } from "@/lib/audit";

/**
 * The merged timeline's list, with a Source on every row.
 *
 * WHY THIS EXISTS INSTEAD OF `@tesserix/web`'s `AuditLogViewer`.
 *
 * The viewer's props are `{entries, emptyMessage?, onEntrySelect?}` and its row
 * type is `{id, actor, action, target?, timestamp, metadata?}`. It renders
 * `actor`, `action`, `target`, `timestamp` and `metadata`; `id` is used only as
 * the React key and as `onEntrySelect`'s argument, so it is never displayed.
 * There is no source field, no column slot, and no render prop.
 *
 * So there are exactly three ways to get attribution onto a row through those
 * props, and two of them are worse than not having it:
 *
 *   1. Put the source in `target` or `metadata`. Rejected. Both carry real
 *      audit data — `target` is what was acted on, `metadata` is the upstream's
 *      severity, IP and before/after diff. Prefixing either makes an audit
 *      record say something that is not what the source recorded, which is a
 *      strictly worse defect than the one being fixed.
 *   2. Group the timeline by source, one viewer per source with a heading.
 *      Rejected. The interleaving IS the surface — "the console granted access
 *      at 09:02 and mark8ly recorded the export at 09:03" is the story a
 *      source-grouped list cannot tell.
 *   3. Render the list here. Chosen, because the honest answer is that the
 *      viewer cannot express per-row attribution and the surface needs its own
 *      rendering. `@tesserix/web` is not modified.
 *
 * The markup deliberately mirrors `AuditLogViewer`'s — same container, same row
 * composition, same classes — so the surface still looks like the design system
 * and so the diff, if a `source` slot is ever added upstream, is a deletion.
 * The design-system gap is real and worth raising there: a viewer for a merged
 * audit log needs a slot for where a row came from.
 *
 * One deliberate difference: the viewer wraps each row in a `<button>` wired to
 * `onEntrySelect`. There is no entry-detail view on this surface, so a button
 * here would be a focusable control that does nothing — this renders a plain
 * element instead.
 */

export interface SourcedAuditListProps {
  readonly entries: readonly SourcedAuditEntry[];
  readonly emptyMessage: string;
}

export function SourcedAuditList({ entries, emptyMessage }: SourcedAuditListProps) {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Audit log</h3>
        <span className="text-xs text-muted-foreground">{entries.length} entries</span>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="rounded-md border p-3 text-left">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {entry.actor} {entry.action}
                    {entry.target ? ` ${entry.target}` : ""}
                  </p>
                  <time className="text-xs text-muted-foreground" dateTime={entry.timestamp}>
                    {entry.timestamp}
                  </time>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {/* The attribution. `sr-only` label because a bare "Fe3dr"
                      badge is unambiguous to a sighted reader scanning a
                      column and meaningless read aloud in sequence. */}
                  <Badge variant="secondary">
                    <span className="sr-only">Source: </span>
                    {sourceLabel(entry.source)}
                  </Badge>
                  {entry.metadata ? (
                    <p className="text-xs text-muted-foreground">{entry.metadata}</p>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
