"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import {
  previewImport,
  commitImport,
  type ImportPreview,
  type ImportResult,
} from "@/lib/db/crm-repo";
import { withCrmWrite } from "@/lib/crm-write";
import { MAX_IMPORT_ROWS, boundFilename, type ImportRow } from "@/lib/crm";

/**
 * CSV import's two server actions.
 *
 * `commitImportAction` goes through `withCrmWrite` (Ruling 17) exactly like
 * every other CRM write — session check, `checkOperatorCapability(session,
 * "read")`, `auditedOperation` under `action: "crm.import"`, error mapping.
 *
 * `previewImportAction` deliberately does NOT: `previewImport` writes
 * nothing (see crm-repo.ts's module comment), and an operator can trigger a
 * preview repeatedly while adjusting a CSV before committing — routing that
 * through `auditedOperation` would fill the audit trail with rows about a
 * look, not a change, which is exactly the accountability signal
 * `auditedOperation` exists to keep meaningful. It still requires console
 * entry, checked the same way ticket actions that don't write do
 * (`platform/tickets/[id]/actions.ts`'s `runTicketAction`).
 *
 * Both actions cap the batch at `MAX_IMPORT_ROWS`, before either the
 * session or the database is touched. Ruling 23 moved `commitImport`'s
 * per-row suppression/dedup reads onto its own transaction's client — which
 * fixes the connection-exhaustion risk of a *concurrent* import, but an
 * unbounded file still holds that one connection, and everything else
 * waiting on the pool, for as long as it takes to walk 2×N round trips.
 */

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the CRM.";
const PREVIEW_FAILED_MESSAGE = "Could not preview this import.";

function tooManyRowsMessage(count: number): string {
  return `This file has ${count} rows; imports are limited to ${MAX_IMPORT_ROWS}. Split it into smaller files.`;
}

export type PreviewImportResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; message: string };

export async function previewImportAction(rows: ImportRow[]): Promise<PreviewImportResult> {
  if (rows.length > MAX_IMPORT_ROWS) {
    return { ok: false, message: tooManyRowsMessage(rows.length) };
  }
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "read");
    const preview = await previewImport(rows);
    return { ok: true, preview };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    return { ok: false, message: PREVIEW_FAILED_MESSAGE };
  }
}

export type CommitImportResult =
  | { ok: true; result: ImportResult }
  | { ok: false; message: string };

export async function commitImportAction(
  rows: ImportRow[],
  filename?: string,
  /** The size of the ORIGINAL file, including rows the client-side parser
   *  (`parseImportCsv`) already dropped as malformed before `rows` ever got
   *  here. Defaults to `rows.length` for a caller with nothing else to
   *  report — `commitImport` then records a self-consistent, if narrower,
   *  batch size. See `commitImport`'s doc comment for why this matters to
   *  `crm_imports.row_count`. */
  totalRows: number = rows.length,
): Promise<CommitImportResult> {
  if (rows.length > MAX_IMPORT_ROWS) {
    return { ok: false, message: tooManyRowsMessage(rows.length) };
  }
  const bounded = boundFilename(filename);
  const result = await withCrmWrite(
    bounded ?? "import",
    (actor) => commitImport(rows, actor.email, bounded, totalRows),
    (outcome: ImportResult) => ({
      action: "crm.import",
      // Counts-only, matching every other CRM audit summary — the real
      // outcome `commitImport` reported, not an assumption that every row
      // in the batch was created.
      summary: {
        created: outcome.created,
        matched: outcome.matchedExisting,
        skipped: outcome.skippedSuppressed,
        malformed: outcome.malformed,
      },
    }),
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/import");
  return { ok: true, result: result.value };
}
