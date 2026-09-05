// Required even though this component uses no hooks of its own:
// `@tesserix/web`'s barrel is itself "use client", and its exports resolve to
// `undefined` when imported into a server component. `use-client-boundary`
// covers `components/kit` and `components/nav`; this file is outside that walk,
// so the directive is on trust here. See `components/kit/page-header.tsx`.
"use client";

import Link from "next/link";
import { Callout, CalloutDescription, CalloutTitle } from "@tesserix/web";
import { AlertTriangle, Info } from "lucide-react";

import { ConsoleDataTable, type Column } from "@/components/kit/console-data-table";
import type { SurfaceState } from "@/components/kit/states";
import {
  COVERAGE_GAP_NOTE,
  COVERAGE_NOTE,
  UNREACHABLE_AUTH_KEYS,
  failureSentence,
  savedCopy,
  sendingNow,
  type EmailTemplateFailure,
  type EmailTemplateRow,
} from "@/lib/email-templates";

export interface EmailTemplatesViewProps {
  rows: EmailTemplateRow[];
  failures: EmailTemplateFailure[];
  state: SurfaceState;
  emptyMessage: string;
}

/**
 * The tone each `sends_from` gets.
 *
 * Only `nothing` is coloured, and only when there is no embedded default to
 * fall back on — that is a key whose call site will send a blank email or none
 * at all, which is a defect in the product. `row` and `embedded` are both
 * correct, ordinary states; colouring `embedded` would read as a warning on
 * every key nobody has ever needed to change.
 */
function sendingTone(row: EmailTemplateRow): string {
  return row.sends_from === "nothing" && !row.has_embedded_default
    ? "text-destructive"
    : "text-foreground";
}

/** Draft is the one saved state whose name does not imply its effect. */
function savedTone(row: EmailTemplateRow): string {
  return row.state === "draft" ? "text-amber-700 dark:text-amber-500" : "text-muted-foreground";
}

function formatUpdated(row: EmailTemplateRow): string {
  if (!row.updated_at) return "—";
  const when = new Date(row.updated_at);
  if (Number.isNaN(when.getTime())) return "—";
  const stamp = when.toISOString().slice(0, 10);
  return row.updated_by ? `${stamp} · ${row.updated_by}` : stamp;
}

/**
 * TWO COLUMNS, NOT ONE BADGE, and that is the whole feature.
 *
 * `state` and `sends_from` are orthogonal. A DRAFT row and an ABSENT row are
 * different things — one is work in progress, one has never been touched — and
 * BOTH send mark8ly's embedded default, because the send path filters on
 * `status = 'published'`. A single "status" chip would show a saved draft as
 * though it were live, which is the one mistake this surface exists to
 * prevent (mark8ly#717).
 *
 * So "Sending now" answers what a customer receives, from `sends_from` alone,
 * and "Stored here" answers what is saved, from `state` alone. The draft row
 * reads `Built-in default` / `Draft — not sending`; the never-edited row reads
 * `Built-in default` / `Never edited`. Same live answer, visibly different
 * reasons — which is exactly what an operator needs before deciding whether
 * their last edit went out.
 */
const COLUMNS: Column<EmailTemplateRow>[] = [
  {
    key: "key",
    header: "Template",
    cell: (row) => (
      <div className="min-w-0">
        <Link
          href={`/mark8ly/email-templates/${encodeURIComponent(row.id)}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.key}
        </Link>
        {/* The RAW subject source, never an interpolated line — it carries no
            customer detail, which is why it is safe on a list page. */}
        <p className="truncate text-xs text-muted-foreground" title={row.subject}>
          {row.subject}
        </p>
      </div>
    ),
  },
  {
    key: "sending",
    header: "Sending now",
    cell: (row) => {
      const described = sendingNow(row);
      return (
        <div className="min-w-0">
          <p className={`font-medium ${sendingTone(row)}`}>{described.label}</p>
          <p className="text-xs text-muted-foreground">{described.detail}</p>
        </div>
      );
    },
  },
  {
    key: "stored",
    header: "Stored here",
    cell: (row) => {
      const described = savedCopy(row);
      return (
        <div className="min-w-0">
          <p className={`font-medium ${savedTone(row)}`}>{described.label}</p>
          <p className="text-xs text-muted-foreground">{described.detail}</p>
        </div>
      );
    },
  },
  {
    key: "version",
    header: "Version",
    // Absent rather than 0 for an unauthored key, so an em dash is the honest
    // rendering — a "v0" beside a template that sends perfectly well reads as
    // a broken row.
    cell: (row) => (
      <span className="text-sm text-muted-foreground">
        {row.version === undefined ? "—" : `v${row.version}`}
      </span>
    ),
  },
  {
    key: "updated",
    header: "Last saved",
    cell: (row) => <span className="text-sm text-muted-foreground">{formatUpdated(row)}</span>,
  },
];

export function EmailTemplatesView({
  rows,
  failures,
  state,
  emptyMessage,
}: EmailTemplatesViewProps) {
  return (
    <div className="space-y-4">
      {/* A PARTIAL LISTING SAYS SO, above the table and outside it. Rendered
          whenever any source failed, including when some rows did arrive: the
          rows below are then a subset, and a table that looks complete is the
          failure `data.failures[]` exists to make visible. The no-rows case is
          already an error state (see `emailTemplatesState`), so this callout
          is what covers the mixed one. */}
      {failures.length > 0 && rows.length > 0 ? (
        <Callout variant="warning" role="alert">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CalloutTitle>This list is incomplete</CalloutTitle>
              <CalloutDescription>
                {failureSentence(failures)} Templates from that product are missing from
                the table below, not absent from the estate.
              </CalloutDescription>
            </div>
          </div>
        </Callout>
      ) : null}

      {/* WHAT THIS PAGE DOES NOT COVER, stated rather than left to be
          discovered. An operator who searches for `password_reset`, finds
          nothing and concludes it does not exist has been misled by omission —
          so the keys are named individually and their home is given. */}
      <Callout variant="info" role="note">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <CalloutTitle>Marketplace templates only</CalloutTitle>
            <CalloutDescription>
              {COVERAGE_NOTE} {COVERAGE_GAP_NOTE} Not here:{" "}
              {UNREACHABLE_AUTH_KEYS.map((key) => (
                <code key={key} className="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs">
                  {key}
                </code>
              ))}
              {/* No link to apps/web. `mark8ly.emailTemplates` records that
                  path, and `pending`'s rule binds renderers: apps/web reaches
                  these rows over the cross-database write path this surface
                  exists to stop using, so naming it is right and linking it is
                  not. */}
            </CalloutDescription>
          </div>
        </div>
      </Callout>

      <ConsoleDataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.key}
        label="Email templates"
        // Unpaged on purpose, matching the producer: the key set is closed and
        // owned by mark8ly's Go call sites, so platform-api serves the whole
        // registry in one response and there can never be a second page. The
        // page controls collapse to a single page at these values.
        total={rows.length}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        onPageChange={() => {
          // Unreachable — there is exactly one page. A no-op rather than a
          // throw: an accidental click must not take the surface down.
        }}
        state={state}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}
