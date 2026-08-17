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
}

export function previewDisplayCounts(preview: ImportPreview, parseMalformed: number): DisplayCounts {
  return {
    toCreate: preview.toCreate,
    matchedExisting: preview.matchedExisting,
    skippedSuppressed: preview.skippedSuppressed,
    malformed: preview.malformed + parseMalformed,
  };
}

export function committedDisplayCounts(result: ImportResult, parseMalformed: number): DisplayCounts {
  return {
    toCreate: result.created,
    matchedExisting: result.matchedExisting,
    skippedSuppressed: result.skippedSuppressed,
    malformed: result.malformed + parseMalformed,
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
