"use client";

import {
  AuditLogViewer,
  Badge,
  Callout,
  CalloutDescription,
  CalloutTitle,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { AuditSourceFailure, SourcedAuditEntry } from "@/lib/audit";
import { sourceLabel } from "@/lib/audit";
import { AuditMetadata } from "./audit-metadata";

/**
 * The client half of the audit timeline.
 *
 * A client component for one reason: the design-system components it renders
 * come from `@tesserix/web`, whose barrel is `"use client"`, and `FilterBar`
 * takes callbacks a server component cannot supply. The page itself stays a
 * server component so both reads happen on the server — the same split as
 * `tickets/queue-view.tsx`.
 */

/**
 * A source that could not be read at all.
 *
 * Distinct from `AuditSourceFailure`, which the aggregate endpoint reports for
 * a source that failed WITHIN an otherwise successful response. This one is a
 * whole read that threw, so it carries a `SurfaceState` and gets the kit's
 * standard rendering — which is how a 501 reaches the operator as
 * "instrumentation unavailable" rather than as a retryable error.
 */
export interface SourceNotice {
  readonly source: string;
  readonly label: string;
  readonly state: SurfaceState;
}

export interface AuditTimelineProps {
  descriptors: FilterDescriptor[];
  /** The filters the server actually applied — see QueueView's `values`. */
  values: FilterValues;
  entries: SourcedAuditEntry[];
  state: SurfaceState;
  emptyMessage: string;
  /** Sources whose read failed outright. */
  notices: readonly SourceNotice[];
  /** Sources the aggregate endpoint could not read, from its own `failures`. */
  failures: readonly AuditSourceFailure[];
  /** What the timeline does and does not reach back to. */
  scopeNote: string;
}

/**
 * The "this timeline is incomplete" banner.
 *
 * Exported so a test can assert it renders the source AND the reason, and so
 * the no-failures case can be asserted to render nothing at all — a test that
 * only checks the surface "renders without error" passes just as happily when
 * the failure list is dropped on the floor, which is the bug worth guarding.
 *
 * Why it exists at all: a reader draws conclusions from what is ABSENT from an
 * audit log. A timeline that quietly omits Kora tells them Kora recorded
 * nothing, which is a stronger and more wrong claim than any error message.
 */
export function IncompleteSources({
  failures,
}: {
  failures: readonly AuditSourceFailure[];
}) {
  if (failures.length === 0) return null;
  return (
    <Callout variant="warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This timeline is incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        {failures.length === 1
          ? "One source could not be read. Events it recorded are missing from the list below."
          : `${failures.length} sources could not be read. Events they recorded are missing from the list below.`}
      </CalloutDescription>
      <ul className="mt-2 space-y-1 text-sm">
        {failures.map((failure) => (
          <li key={failure.source}>
            <span className="font-medium">{sourceLabel(failure.source)}</span>
            {" — "}
            {failure.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * The Source cell for a row, passed to `AuditLogViewer`'s `renderSource`.
 *
 * `sr-only` label because a bare "Fe3dr" badge is unambiguous to a sighted
 * reader scanning a column and meaningless read aloud in sequence.
 *
 * A `Badge`, not bare text: the viewer's default renders `source` as plain
 * muted text next to the timestamp, where it reads as part of the timestamp.
 * `Badge` is a `<span>`, so it nests legally inside the `<span>` the viewer
 * wraps this in.
 */
function renderSource(source: string) {
  return (
    <Badge variant="secondary">
      <span className="sr-only">Source: </span>
      {sourceLabel(source)}
    </Badge>
  );
}

/** See `audit-metadata.tsx` for why this is not the raw JSON string. */
function renderMetadata(metadata: string) {
  return <AuditMetadata metadata={metadata} />;
}

export function AuditTimeline({
  descriptors,
  values,
  entries,
  state,
  emptyMessage,
  notices,
  failures,
  scopeNote,
}: AuditTimelineProps) {
  const { set, clear } = useUrlFilters(descriptors);

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        descriptors={descriptors}
        values={values}
        onChange={set}
        onClear={clear}
      />

      {/* Source status comes FIRST, above the list. An operator who scrolls a
          timeline and only afterwards learns a source was missing has already
          drawn a conclusion from it. */}
      {notices.map((notice) => (
        <section key={notice.source} aria-label={`${notice.label} audit source`}>
          <p className="pb-1 text-xs font-medium text-muted-foreground">
            {notice.label}
          </p>
          <SurfaceStateView state={notice.state} emptyMessage={emptyMessage} />
        </section>
      ))}

      <IncompleteSources failures={failures} />

      {/* The list renders whatever rows the working sources produced, each with
          the source that produced it. It is shown alongside the notices above,
          never instead of them: one source being down must not blank out the
          others' rows.

          This used to be `sourced-audit-list.tsx`, a local re-implementation of
          `AuditLogViewer`'s markup that existed only because the viewer's row
          type had no `source` and its props had no slot to put one in. That
          gap is closed as of `@tesserix/web` 1.13.0 (design-system#12), so the
          local copy is deleted and this is the viewer again — with the
          attribution supplied through `renderSource` rather than smuggled into
          `target` or `metadata`, which carry the source's own audit data and
          must keep saying what the source recorded.

          No `onEntrySelect`: there is no entry-detail view on this surface, and
          as of 2.1.0 the viewer renders a row as a plain element rather than a
          `<button>` when the callback is absent — so omitting it is now the
          whole fix for what used to be a focusable control that did nothing. */}
      {state.kind === "ready" ? (
        <AuditLogViewer
          entries={entries}
          emptyMessage={emptyMessage}
          renderSource={renderSource}
          renderMetadata={renderMetadata}
        />
      ) : (
        <SurfaceStateView
          state={state}
          emptyMessage={emptyMessage}
          onClearFilters={clear}
        />
      )}

      <p className="text-xs text-muted-foreground">{scopeNote}</p>
    </div>
  );
}
