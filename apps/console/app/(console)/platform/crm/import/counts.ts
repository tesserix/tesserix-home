import type { ImportRow } from "@/lib/crm";
import type { ImportPreview, ImportResult } from "@/lib/db/crm-repo";

/**
 * The four numbers `import-view.tsx` shows an operator, for either a
 * preview or a completed commit.
 *
 * Pulled out as pure functions, tested independently of any rendering, for
 * the exact reason Important 3 existed: `import-view.tsx` used to compute
 * the preview card's malformed count as `preview.malformed + parseMalformed`
 * inline, and the committed card's as `committed.malformed` alone — two
 * independent expressions for "how many rows this file dropped" that only
 * one of them remembered to fold `parseMalformed` (the rows the client-side
 * `parseImportCsv` already rejected, before either `previewImport` or
 * `commitImport` ever saw them) into. Same operator, same file: preview said
 * "Malformed 3", the commit summary said "Malformed 0". Routing both call
 * sites through these two functions — which share the same
 * `+ parseMalformed` — makes that divergence structurally impossible to
 * reintroduce; `counts.test.ts` pins the property directly.
 */
export interface DisplayCounts {
  toCreate: number;
  matchedExisting: number;
  skippedSuppressed: number;
  malformed: number;
  /**
   * Rows created with their `website_url` dropped as unsafe. `null` — not 0
   * — on a preview: `previewImport` writes nothing and so drops nothing, and
   * showing "Website dropped 0" beside a preview would assert a fact about
   * an import that has not happened. The card renders this cell only when it
   * is a number.
   */
  droppedWebsiteUrls: number | null;
}

export function previewDisplayCounts(preview: ImportPreview, parseMalformed: number): DisplayCounts {
  return {
    toCreate: preview.toCreate,
    matchedExisting: preview.matchedExisting,
    skippedSuppressed: preview.skippedSuppressed,
    malformed: preview.malformed + parseMalformed,
    droppedWebsiteUrls: null,
  };
}

export function committedDisplayCounts(result: ImportResult, parseMalformed: number): DisplayCounts {
  return {
    toCreate: result.created,
    matchedExisting: result.matchedExisting,
    skippedSuppressed: result.skippedSuppressed,
    malformed: result.malformed + parseMalformed,
    droppedWebsiteUrls: result.droppedWebsiteUrls,
  };
}

/**
 * A human label for a row in the "left unchanged" list — whichever
 * identifying field it carries, in the same name > email > Instagram
 * priority `commitImport` itself uses to name a newly created organisation
 * (crm-repo.ts). `isUsableImportRow` guarantees at least one of these three
 * is present for every row that could ever end up in `matchedRows`, so the
 * fallback string is unreachable in practice — kept only so this stays a
 * total function.
 */
export function matchedRowLabel(row: ImportRow): string {
  return row.name?.trim() || row.email?.trim() || row.instagramHandle?.trim() || "(unidentified row)";
}

/** How many rows the "left unchanged" list renders before summarising the
 *  rest as "and N more" — Minor (review round 2): at `MAX_IMPORT_ROWS`, an
 *  all-matched import would otherwise render a 500-`<li>` list. */
export const MATCHED_ROWS_DISPLAY_LIMIT = 25;

export interface VisibleMatchedRows {
  visible: readonly ImportRow[];
  /** Rows beyond `MATCHED_ROWS_DISPLAY_LIMIT`, named as a count rather than
   *  rendered — 0 when the full list already fits. */
  more: number;
}

export function visibleMatchedRows(rows: readonly ImportRow[]): VisibleMatchedRows {
  return {
    visible: rows.slice(0, MATCHED_ROWS_DISPLAY_LIMIT),
    more: Math.max(0, rows.length - MATCHED_ROWS_DISPLAY_LIMIT),
  };
}
