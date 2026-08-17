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
import { AuditWriteError } from "@/lib/db/audit-repo";
import { MAX_IMPORT_ROWS, boundFilename, validateTotalRows, type ImportRow } from "@/lib/crm";
import { committedDisplayCounts } from "./counts";

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

/**
 * `AuditWriteError` means the batch COMMITTED and only the audit row failed
 * — `auditedOperation` runs the operation first and refuses to hand back its
 * result if it could not record it. The shared wrapper's default for that is
 * "That change was not saved", which is the safe thing to say about one
 * stage change and a plain falsehood about this write: the rows are in the
 * database, and an operator told nothing was saved will re-upload the same
 * CSV — which `commitImport`'s own dedup will then report as hundreds of
 * "matched existing" rows, leaving them with no idea which run is real.
 *
 * Still `ok: false`: the import IS unaccounted for, this action's result is
 * deliberately discarded, and reporting success for a write nobody can audit
 * would defeat the control. The message just has to say which of the two
 * happened.
 */
function mapUnrecordedCommit(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof AuditWriteError) {
    return {
      ok: false,
      message:
        "The rows were imported, but the action could not be recorded in the audit log. " +
        "Do not re-run this import — check the CRM before importing again.",
    };
  }
  return undefined;
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
  // Important 2 (review round 2), Ruling 26 (review round 3): totalRows is
  // a server-action parameter — reachable directly over the network, no
  // client in between guaranteeing it's sane — flowing into
  // `crm_imports.row_count`/`.skipped_count`, `integer NOT NULL` columns
  // with no CHECK. Rejected, not clamped: a silently-corrected value would
  // still feed the audit record (`parseMalformed` below is derived from
  // it), which is the same failure mode `serialiseSummary`/
  // `validateActionName` already reject rather than sanitise elsewhere in
  // this codebase — a capability-gated operator could otherwise plant a
  // false audit summary with no error and no trace.
  const totalRowsProblem = validateTotalRows(totalRows, rows.length);
  if (totalRowsProblem) {
    return { ok: false, message: totalRowsProblem };
  }
  const bounded = boundFilename(filename);
  // The rows the client-side parser dropped before this batch ever formed
  // — recoverable from the gap between the (now validated) total and what's
  // actually being committed, without a third parameter for the same fact
  // `totalRows` already carries.
  const parseMalformed = totalRows - rows.length;
  const result = await withCrmWrite(
    bounded ?? "import",
    (actor) => commitImport(rows, actor.email, bounded, totalRows),
    (outcome: ImportResult) => {
      // Minor (review round 2): routed through the SAME `committedDisplayCounts`
      // the UI's committed card uses (`import-view.tsx`, `counts.ts`) — this
      // summary was a third, independent copy of these counts that forgot
      // to fold in `parseMalformed`, and so disagreed with both UI cards
      // for the same import. One function both call sites share now.
      const counts = committedDisplayCounts(outcome, parseMalformed);
      return {
        action: "crm.import",
        summary: {
          created: counts.toCreate,
          matched: counts.matchedExisting,
          skipped: counts.skippedSuppressed,
          malformed: counts.malformed,
        },
      };
    },
    mapUnrecordedCommit,
  );
  if (!result.ok) return result;
  revalidatePath("/platform/crm/import");
  return { ok: true, result: result.value };
}
