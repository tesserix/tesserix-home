/**
 * The canonical form of the two identifiers the CRM matches people on.
 *
 * # Why this is its own module
 *
 * These two functions lived in `crm-repo.ts`, beside the only three callers
 * that existed: `isSuppressed`, `findMatchingOrganisationId` and
 * `importRowKeys`. #226 added a fourth on the other side of the estate —
 * `crm-erasure-hash.ts`, which HMACs an identifier so an erased person cannot
 * be re-created by the next import — and importing them from `crm-repo.ts`
 * would have made `crm-repo` and `crm-erasure-hash` import each other. A
 * cycle between two modules that only exchange pure functions happens to
 * work under both ESM and the bundler, which is precisely what makes it a bad
 * thing to rely on: it fails later, somewhere else, for a reason nobody
 * connects back to here.
 *
 * # Why it must be ONE implementation and not two agreeing ones
 *
 * The erasure hash and the import lookup have to derive the SAME string from
 * the same person, or the feature is a silent no-op: the hash recorded at
 * erasure never equals the hash computed for the incoming row, every check
 * misses, no row is ever refused, and every test that mocks one side still
 * passes. Nothing fails loudly — the import simply re-creates the person it
 * was built to refuse, which is the original bug wearing a fix.
 *
 * That is not hypothetical for this repo. It is the shape of #433 (a
 * normalisation the two halves of one write disagreed about) and of #215 (a
 * handle keyed one way and looked up another). A second implementation that
 * "matches" is a second implementation that can stop matching in one commit.
 * So: one definition, imported everywhere, and `crm-erasure-hash.test.ts`
 * pins the agreement against the real function rather than a copy of it.
 *
 * `crm-repo.ts` re-exports `normalizeInstagramHandle` so its existing
 * importers (`crm-writes.ts`) do not have to care that it moved.
 */

/**
 * Trim and lowercase — the form every email comparison in the CRM already
 * makes, expressed once.
 *
 * The trim is not cosmetic. `crm_suppressions`' migration-0022 trigger stores
 * `trim(lower(email))`, and `commitImport` stores `email.trim().toLowerCase()`
 * on `crm_contacts`, so the STORED side is always trimmed; a lookup that
 * skipped the trim would miss a real match on nothing but the leading space a
 * CSV cell carries as a matter of course.
 *
 * The lowercase is redundant with the `lower(...)` in the SQL those lookups
 * issue, and deliberately kept anyway: the erasure hash has no SQL to fall
 * back on, and a caller should not have to know which of its two
 * case-insensitivity mechanisms is doing the work.
 */
export function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Strips a leading `@` and lowercases, so `@BondiBaker` and `bondibaker`
 *  are the same key on both the write and the read side (Ruling 18).
 *
 *  Used by `crm-writes.ts`'s `insertContact` (#236): the manual-create door
 *  checks the suppression list through `isSuppressed`, which normalises here,
 *  so its INSERT has to hand over the same string this produces or the two
 *  halves of one write disagree about what the handle is. Migration 0023's
 *  `crm_contacts_normalize_trg` keeps the stored column in this same form, so
 *  `crm_contacts_instagram_lower_uq` constrains what a lookup actually looks
 *  up. */
export function normalizeInstagramHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}
