"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  ErasureCheckUnavailableError,
  previewImport,
  commitImport,
  type ImportPreview,
  type ImportResult,
} from "@/lib/db/crm-repo";
import { withCrmWrite } from "@/lib/crm-write";
import { AuditWriteError } from "@/lib/db/audit-repo";
import { MAX_IMPORT_ROWS, boundFilename, validateTotalRows, type ImportRow } from "@/lib/crm";
// A `"use server"` module may export only async functions, so the vocabulary
// and its predicate are imported rather than owned here — same shape as
// `NO_PRODUCT_VALUE` on the manual-create action.
import {
  LAWFUL_BASIS_REQUIRED_MESSAGE,
  isSelectableLawfulBasis,
  unknownLawfulBasisMessage,
} from "@/lib/crm-provenance";
import { committedDisplayCounts } from "./counts";

/**
 * CSV import's two server actions.
 *
 * `commitImportAction` goes through `withCrmWrite` (Ruling 17) exactly like
 * every other CRM write — session check, `checkOperatorCapabilityLive(session,
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
    // A preview of up to 500 contacts is CRM data. It sat on `read` — the
    // console entry ticket — which is the case #261 opens with.
    await checkOperatorCapabilityLive(session, "crm");
    const preview = await previewImport(rows);
    return { ok: true, preview };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    // Shown verbatim, unlike every other failure here, because it is the one
    // an operator can do something about and the generic "Could not preview
    // this import" would send them to re-upload the same file forever. The
    // message names an environment variable and nothing about any person or
    // any row — see `ErasureCheckUnavailableError` for why the refusal exists
    // at all.
    if (cause instanceof ErasureCheckUnavailableError) {
      return { ok: false, message: cause.message };
    }
    // The two cases above are the ones with something useful to say to the
    // operator. Everything else reaches the generic message — and used to
    // reach it having discarded the only thing that explains the failure,
    // which made "Could not preview this import" undiagnosable from the
    // outside: no stack, no pod log line, nothing to grep. An operator can
    // report that they saw it and that is the end of what anyone can learn.
    //
    // Logged, not surfaced. The cause may be a driver error naming a column
    // or a constraint, and this action's whole input is other people's
    // contact details — the message stays generic for the reason every other
    // failure here does. `rows.length` is the one safe fact worth having
    // beside it: a failure at 500 rows and a failure at 2 are different bugs.
    logPreviewFailure(cause, rows.length);
    return { ok: false, message: PREVIEW_FAILED_MESSAGE };
  }
}

/**
 * Why a bare `console.error` rather than the structured logger: there is not
 * one. `apps/console` reports server-side faults this way throughout —
 * `app/auth/callback/route.ts` alone does it six times — and introducing a
 * second convention for one call site would leave the next reader unsure
 * which to grep for.
 *
 * NO ROW DATA. Not the rows, not a sample, not a count of how many carried an
 * email. A CSV of scraped sellers is exactly the data an operator is not
 * entitled to see in a log line they did not already have access to, and a
 * log is read by more people and retained longer than the surface that
 * produced it.
 */
function logPreviewFailure(cause: unknown, rowCount: number): void {
  console.error("[crm/import] preview failed", {
    rowCount,
    name: cause instanceof Error ? cause.name : typeof cause,
    message: cause instanceof Error ? cause.message : String(cause),
    stack: cause instanceof Error ? cause.stack : undefined,
  });
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
  // Nothing was written — `assertErasureCheckable` runs before the
  // `crm_imports` insert and the transaction rolls back regardless. Mapped
  // for the same reason `previewImportAction` maps it: the wrapper's default
  // "That change was not saved" is true but useless, and this message is the
  // only thing that tells anyone which variable to set. It repeats no
  // personal data; the refusal is a fact about the deployment.
  if (cause instanceof ErasureCheckUnavailableError) {
    return { ok: false, message: cause.message };
  }
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
  /** The lawful basis the whole batch is held under (#248). Second and
   *  required, ahead of the optional reporting parameters, because there is
   *  no correct value to fall back on: `crm_contacts.lawful_basis` is what a
   *  subject-access request is answered from, and a default would record a
   *  claim nobody made. Validated below, before any session or database
   *  work — the same boundary `product` is checked against `ESTATE` at. */
  lawfulBasis: string,
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
  // Rejected, never coerced. `not_recorded_pre_migration` fails here like any
  // other unknown string: it is storable, because 259 migrated rows carry it,
  // but choosing it for a new batch would be recording "we do not know" as a
  // decision — see `LEGACY_LAWFUL_BASIS`.
  if (!lawfulBasis) {
    return { ok: false, message: LAWFUL_BASIS_REQUIRED_MESSAGE };
  }
  if (!isSelectableLawfulBasis(lawfulBasis)) {
    return { ok: false, message: unknownLawfulBasisMessage(lawfulBasis) };
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
    // The basis goes in `target`, not in `summary`: `AuditSummary` is
    // `Record<string, number>` and rejects anything that is not a count. It
    // belongs on the audit row at all because "which basis was this batch
    // declared under, and by whom" is a question about the DECISION — the
    // contact rows record what was written, the audit log records who chose
    // it and when.
    `${bounded ?? "import"} (${lawfulBasis})`,
    { capability: "crm" },
    (actor) => commitImport(rows, actor.email, lawfulBasis, bounded, totalRows),
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
          // Its own key, not added into `skipped`: the audit row is the
          // record that an erasure was honoured on the import side too, and
          // a number folded into another number evidences nothing.
          erased: counts.skippedErased,
          malformed: counts.malformed,
        },
      };
    },
    mapUnrecordedCommit);
  if (!result.ok) return result;
  revalidatePath("/platform/crm/import");
  return { ok: true, result: result.value };
}
