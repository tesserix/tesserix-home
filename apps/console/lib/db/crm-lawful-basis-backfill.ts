import { LEGACY_LAWFUL_BASIS, type LawfulBasis } from "../crm-provenance";
import { setLawfulBasis } from "./crm-writes";
import { tesserixQuery } from "./tesserix";

/**
 * Bulk lawful-basis determination: select a cohort of contacts by the basis
 * they currently hold, and record a different one against each through the
 * audited writer.
 *
 * Written for #248, which gave the migrated contacts their first basis
 * (`not_recorded_pre_migration` → a real value). It now also serves the
 * correction of that backfill's own output: #248 wrote `legitimate_interests`
 * onto the 259 Indian contacts, which is a GDPR basis DPDP does not have, so
 * they move to `dpdp_public_data_exempt`. Same shape, different `from`.
 *
 * # Why a library function with a thin CLI over it
 *
 * `scripts/catalog-bootstrap.ts`'s rule, applied unchanged: the script owns
 * argv, exit codes and logging; what gets changed and what gets refused lives
 * here, where it is unit-testable without a process.
 *
 * # What it selects, and the rows it will not touch
 *
 * Candidates are contacts holding the basis named by `from` — by default
 * `not_recorded_pre_migration`, the marker migration 0027 left on rows
 * acquired before the column existed, and the one value
 * `isSelectableLawfulBasis` refuses to let any live path write. A contact
 * holding anything else is left alone: somebody decided that, and a bulk job
 * must not overwrite a human's determination.
 *
 * When `from` names a real basis rather than the legacy marker, that
 * protection weakens — `legitimate_interests` is a human determination, and
 * the right one for most of the list. `source` is what narrows it back: see
 * `BackfillLawfulBasisOptions.source` for why the DPDP correction must be
 * keyed on the cohort and not on the old value alone.
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
 * still holding `from`, so a second run finds nothing and writes nothing — a
 * row this job already moved no longer matches. A partial run that died
 * halfway can simply be run again. `from === basis` is refused for this
 * reason: it is the one combination where "0 changed" would mean the flags
 * were wrong rather than the work being done.
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
  /**
   * The basis a row must CURRENTLY hold to be a candidate. Defaults to
   * `LEGACY_LAWFUL_BASIS`, which is the #248 case this job was written for
   * and the only behaviour any existing caller gets.
   *
   * It is a parameter because the #248 backfill itself recorded the wrong
   * value: it wrote `legitimate_interests` onto the 259 migrated Indian
   * contacts, and legitimate interests is a GDPR concept that DPDP does not
   * have (see `DPDP_PUBLIC_DATA_EXEMPT`). Correcting that is the same job —
   * select a cohort by the basis it holds, write a determination through the
   * audited writer — against a different starting value, so it is the same
   * code with `from` supplied rather than a second module that would
   * duplicate the `erased_at` filter and the failure-tolerance below.
   */
  from?: LawfulBasis;
  /**
   * Restrict candidates to one `crm_contacts.source`. Optional, and omitted
   * means every source.
   *
   * This exists because the DPDP correction must NOT be applied by basis
   * alone. `legitimate_interests` is the right label for the Australian,
   * Canadian and European contacts imported later, and a relabel keyed only
   * on the old value would overwrite all of them with an India-only
   * exemption. `source = 'instagram_outreach'` is what isolates the migrated
   * cohort — it is the value all 259 production rows carry, per
   * `CONTACT_SOURCE`'s note, and no later import writes it.
   *
   * Country was NOT usable when this was written: `crm_organisations.country`
   * was NULL for 208 of 259 rows. The mapper has since learned the ten
   * markets and the backfill has run, so `country` below is now the precise
   * filter and `source` is the blunt one.
   */
  source?: string;
  /**
   * Restrict candidates to one `crm_organisations.country` (ISO 3166-1
   * alpha-2, as that column stores). Optional; omitted means every country.
   *
   * Added because `source` stopped being able to separate the cohorts. The
   * 2026-09 sweep imported all ten markets in two batches that both landed as
   * `source = 'import'`, so after the second batch the six Indian contacts —
   * which need `dpdp_public_data_exempt` rather than the GDPR basis the other
   * 367 correctly carry — were no longer addressable by source alone.
   *
   * It is a filter on the ORGANISATION, not the contact: `country` is derived
   * from `crm_organisations.location` by `@tesserix/crm-country`, and a
   * contact has no location of its own.
   */
  country?: string;
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
  const { basis, actor, dryRun, limit, from, source, country } = options;
  const currentBasis = from ?? LEGACY_LAWFUL_BASIS;

  // Refused rather than treated as a no-op: `setLawfulBasis` compares before
  // writing, so a run where `from === basis` would report 259 candidates and
  // 0 changed — a line that reads exactly like "already done" and would be
  // filed as a successful correction. The operator got a flag wrong and has
  // to be told so.
  if (currentBasis === basis) {
    throw new Error(
      `--from and --basis are both "${basis}"; that would change nothing while reporting a clean run.`,
    );
  }

  // Placeholders are numbered from the params actually pushed rather than
  // hardcoded, because `source` and `country` are independently optional:
  // with `$2` written into the country clause, a country-only run would bind
  // it to a parameter that was never added.
  const params: unknown[] = [currentBasis];
  const clauses: string[] = [];
  if (source !== undefined) {
    params.push(source);
    clauses.push(`AND c.source = $${params.length}`);
  }
  if (country !== undefined) {
    params.push(country);
    clauses.push(`AND o.country = $${params.length}`);
  }

  // The join is unconditional even when `country` is absent. `organisation_id`
  // is NOT NULL on `crm_contacts`, so an inner join cannot drop a row, and one
  // query shape means the country-filtered path and the unfiltered one cannot
  // diverge in what they consider a candidate.
  const rows = await tesserixQuery<CandidateRow>(
    `SELECT c.id
       FROM crm_contacts c
       JOIN crm_organisations o ON o.id = c.organisation_id
      WHERE c.lawful_basis = $1
        AND c.erased_at IS NULL
        ${clauses.join("\n        ")}
      ORDER BY c.created_at
      ${limit === undefined ? "" : "LIMIT " + String(Number(limit))}`,
    params,
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
