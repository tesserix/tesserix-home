import { LEGACY_LAWFUL_BASIS, type LawfulBasis } from "../crm-provenance";
import { setLawfulBasis } from "./crm-writes";
import { tesserixQuery } from "./tesserix";

/**
 * The one-off backfill that gives the migrated contacts a lawful basis (#248).
 *
 * # Why a library function with a thin CLI over it
 *
 * `scripts/catalog-bootstrap.ts`'s rule, applied unchanged: the script owns
 * argv, exit codes and logging; what gets changed and what gets refused lives
 * here, where it is unit-testable without a process.
 *
 * # What it selects, and the two rows it will not touch
 *
 * Candidates are contacts still holding `not_recorded_pre_migration` — the
 * marker migration 0027 left on rows acquired before the column existed, and
 * the one value `isSelectableLawfulBasis` refuses to let any live path write.
 * A contact that already carries a real basis is left alone: somebody decided
 * that, and a bulk job must not overwrite a human's determination with a
 * default.
 *
 * ERASED CONTACTS ARE EXCLUDED. `eraseContact` pseudonymises the row and
 * stamps `erased_at`; recording a fresh lawful basis for holding the details
 * of someone who asked to be forgotten would assert a justification for
 * exactly the data the erasure destroyed. The filter is `erased_at IS NULL`
 * and it is not optional.
 *
 * # Why it goes through `setLawfulBasis` rather than one UPDATE
 *
 * A single `UPDATE crm_contacts SET lawful_basis = $1 WHERE ...` would be one
 * statement instead of 259 transactions, and it would leave no record of who
 * determined the basis or when. That record IS the deliverable — a basis
 * nobody can trace back to a decision evidences nothing when a data subject
 * asks. `setLawfulBasis` writes the same per-field timeline row the console's
 * own edit writes, so a backfilled row and a hand-edited one read identically
 * to whoever reads them next.
 *
 * # Re-running it is safe
 *
 * `setLawfulBasis` compares before writing and the SELECT only returns rows
 * still holding the legacy marker, so a second run finds nothing and writes
 * nothing. A partial run that died halfway can simply be run again.
 */
export interface BackfillLawfulBasisOptions {
  /** The basis to record. Must be selectable — the legacy marker is refused
   *  by `setLawfulBasis`, which is what stops this job writing it back. */
  basis: LawfulBasis;
  actor: string;
  /** Report what would change and write nothing. */
  dryRun: boolean;
  /** Stop after this many contacts. For rehearsing on a handful before
   *  committing to the whole set. */
  limit?: number;
}

export interface BackfillLawfulBasisFailure {
  contactId: string;
  message: string;
}

export interface BackfillLawfulBasisResult {
  /** How many rows still hold the legacy marker. */
  candidates: number;
  /** How many this run actually changed. Zero on a dry run, by construction. */
  changed: number;
  /** Candidates that raised. The run CONTINUES past a failure — one bad row
   *  must not strand the other 258 halfway through a compliance backfill —
   *  and every one is reported so the count cannot be read as a success. */
  failures: BackfillLawfulBasisFailure[];
}

interface CandidateRow {
  id: string;
}

export async function backfillLawfulBasis(
  options: BackfillLawfulBasisOptions,
): Promise<BackfillLawfulBasisResult> {
  const { basis, actor, dryRun, limit } = options;

  const rows = await tesserixQuery<CandidateRow>(
    `SELECT id
       FROM crm_contacts
      WHERE lawful_basis = $1
        AND erased_at IS NULL
      ORDER BY created_at
      ${limit === undefined ? "" : "LIMIT " + String(Number(limit))}`,
    [LEGACY_LAWFUL_BASIS],
  );

  const result: BackfillLawfulBasisResult = {
    candidates: rows.length,
    changed: 0,
    failures: [],
  };
  if (dryRun) return result;

  for (const row of rows) {
    try {
      const { changed } = await setLawfulBasis({
        contactId: row.id,
        lawfulBasis: basis,
        actor,
      });
      if (changed.length > 0) result.changed += 1;
    } catch (cause) {
      result.failures.push({
        contactId: row.id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return result;
}
