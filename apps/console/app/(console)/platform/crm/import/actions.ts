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
import type { ImportRow } from "@/lib/crm";

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
 */

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the CRM.";
const PREVIEW_FAILED_MESSAGE = "Could not preview this import.";

export type PreviewImportResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; message: string };

export async function previewImportAction(rows: ImportRow[]): Promise<PreviewImportResult> {
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
): Promise<CommitImportResult> {
  const result = await withCrmWrite(
    filename ?? "import",
    (actor) => commitImport(rows, actor.email, filename),
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
