"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Callout, CalloutDescription, Input } from "@tesserix/web";
import { parseImportCsv, type ImportRow } from "@/lib/crm";
import type { ImportPreview, ImportResult } from "@/lib/db/crm-repo";
import { previewImportAction, commitImportAction } from "./actions";
import {
  previewDisplayCounts,
  committedDisplayCounts,
  matchedRowLabel,
  visibleMatchedRows,
  type DisplayCounts,
} from "./counts";

/**
 * CSV import: pick a file, preview what it would do, commit.
 *
 * All CSV parsing happens client-side, via the same pure `parseImportCsv`
 * `lib/crm.test.ts` covers — there is nothing DB-dependent about turning a
 * file's text into rows. The two DB-dependent steps, previewing and
 * committing, go through server actions.
 *
 * Suppression is checked on BOTH `previewImportAction` and
 * `commitImportAction` — this view calls commit with the very same `rows`
 * array the preview ran against, and still gets a fresh answer, because a
 * preview a few minutes old is exactly what could go stale (see
 * crm-repo.ts's module comment on `previewImport`/`commitImport`).
 */

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout role="alert" variant="destructive" className="mt-2">
      <CalloutDescription>{message}</CalloutDescription>
    </Callout>
  );
}

function CountsSummary({
  counts,
  title,
  matchedRows,
}: {
  counts: DisplayCounts;
  title: string;
  /** The rows behind `counts.matchedExisting`, if any — see the note below
   *  the grid: dedup-only is deliberate (never overwrite an
   *  operator-curated organisation with scraped CSV data), but that means
   *  these rows' CSV data is discarded, and a bare number reads as success
   *  to an operator importing, say, updated phone numbers. */
  matchedRows: readonly ImportRow[];
}) {
  const { visible, more } = visibleMatchedRows(matchedRows);
  return (
    <div className="rounded-md border border-border p-4 text-sm">
      <p className="font-medium">{title}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">To create</dt>
          <dd className="mt-1 text-lg">{counts.toCreate}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Matches existing</dt>
          <dd className="mt-1 text-lg">{counts.matchedExisting}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Suppressed</dt>
          <dd className="mt-1 text-lg">{counts.skippedSuppressed}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Malformed</dt>
          <dd className="mt-1 text-lg">{counts.malformed}</dd>
        </div>
      </dl>
      {matchedRows.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3 text-muted-foreground">
          <p>
            These already exist in the CRM. This import leaves them unchanged — their CSV data
            (updated phone numbers, notes, etc.) is <strong>not</strong> applied, so a hand-corrected
            record is never silently overwritten by a scrape.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {visible.map((row, index) => (
              // Import rows carry no stable id of their own — this is a
              // display-only list over an immutable array from one
              // preview/commit response, so position is a safe key here.
              <li key={index}>{matchedRowLabel(row)}</li>
            ))}
          </ul>
          {more > 0 ? <p className="mt-1">…and {more} more.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ImportView() {
  const [filename, setFilename] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [parseMalformed, setParseMalformed] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [committed, setCommitted] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleFile = (file: File) => {
    setError(null);
    setPreview(null);
    setCommitted(null);
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const parsed = parseImportCsv(text);
      // A whole-file rejection, not a per-row one: nothing is offered for
      // preview, because the rows this parser would produce from a file with
      // an unclosed quote are fragments that look like real businesses.
      if (parsed.rejected) {
        setError(parsed.rejected);
        setRows(null);
        setParseMalformed(0);
        return;
      }
      setRows(parsed.rows);
      setParseMalformed(parsed.malformed);
    };
    reader.onerror = () => {
      setError("Could not read that file.");
      setRows(null);
    };
    reader.readAsText(file);
  };

  const runPreview = () => {
    if (!rows) return;
    setError(null);
    startTransition(async () => {
      const result = await previewImportAction(rows);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPreview(result.preview);
    });
  };

  const runCommit = () => {
    if (!rows) return;
    setError(null);
    startTransition(async () => {
      // The full file size — including whatever parseImportCsv already
      // dropped as malformed — so crm_imports.row_count reflects the whole
      // file the operator picked, not just the rows that survived parsing.
      const totalRows = rows.length + parseMalformed;
      const result = await commitImportAction(rows, filename ?? undefined, totalRows);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setCommitted(result.result);
      setPreview(null);
      setRows(null);
      setFilename(null);
    });
  };

  // Both derived from the same two functions the preview card and the
  // committed card use — see counts.ts's doc comment for why that sharing
  // is the actual fix for "preview said Malformed 3, commit said Malformed
  // 0" (Important 3): two independent inline expressions were how that
  // divergence happened in the first place.
  const previewCounts = preview ? previewDisplayCounts(preview, parseMalformed) : null;
  const committedCounts = committed ? committedDisplayCounts(committed, parseMalformed) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="crm-import-file">
            CSV file
          </label>
          <Input
            id="crm-import-file"
            type="file"
            accept=".csv,text/csv"
            className="mt-1"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
        <Button type="button" size="sm" disabled={!rows || pending} onClick={runPreview}>
          {pending ? "Working…" : "Preview"}
        </Button>
      </div>

      <ErrorNote message={error} />

      {previewCounts && preview ? (
        <div className="flex flex-col gap-3">
          <CountsSummary
            counts={previewCounts}
            title={`Preview — ${filename ?? "file"} (nothing written yet)`}
            matchedRows={preview.matchedRows}
          />
          <div>
            <Button type="button" size="sm" disabled={pending} onClick={runCommit}>
              {pending ? "Importing…" : "Commit import"}
            </Button>
          </div>
        </div>
      ) : null}

      {committedCounts && committed ? (
        <div className="flex flex-col gap-3">
          <CountsSummary
            counts={committedCounts}
            title="Import committed"
            matchedRows={committed.matchedRows}
          />
          {/* Without this the import flow was a dead end: it reported "47
           *  created" and offered no way to see any of them, and those rows
           *  sat on neither CRM queue for fourteen days. Gated on `created`,
           *  not just rendering unconditionally — an import that only
           *  matched or skipped rows created nothing this link could show. */}
          {committed.created > 0 ? (
            <Link
              href={`/platform/crm/organisations?import=${committed.importId}`}
              className="text-sm font-medium hover:underline"
            >
              View {committed.created} new organisations
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
