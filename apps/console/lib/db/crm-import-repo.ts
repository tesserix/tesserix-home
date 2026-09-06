/**
 * The CRM CSV import surface: match/erasure lookups, the dry-run preview, and
 * the transactional commit.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 */
import { countryFromLocation } from "@tesserix/crm-country";
import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import { isSafeWebsiteUrl } from "./crm-url";
import { CONTACT_SOURCE, isSelectableLawfulBasis, type LawfulBasis } from "../crm-provenance";
import { normalizeContactEmail, normalizeInstagramHandle } from "./crm-identity";
import {
  ERASURE_HASH_KEY_ENV,
  erasureHashes,
  isErasureHashKeyConfigured,
} from "./crm-erasure-hash";
import {
  isUsableImportRow,
  parseCountCell,
  parseMetadataCell,
  type ImportRow,
} from "../crm";
import { isSuppressed, type SuppressionCheck } from "./crm-suppressions-repo";

/**
 * CSV import (Task 8).
 *
 * The rule this section exists to hold: **suppression is checked at BOTH
 * preview and commit, never only at preview.** A preview can be minutes
 * old; someone can be suppressed in the gap between an operator reviewing a
 * preview and clicking "commit", and skipping the check on commit would
 * then contact a person who asked not to be. Both `previewImport` and
 * `commitImport` call `isSuppressed` — the same function, the same
 * trimmed/lowercased email and `normalizeInstagramHandle`'d Instagram
 * comparison the do-not-contact list itself uses — so the two paths can
 * never disagree about who is protected.
 *
 * The same rule now holds for the erasure register (#226): both paths call
 * `isErased`, in the same order relative to `isSuppressed`, so neither can
 * report a file differently from the other. Erasure has the stronger claim of
 * the two — a suppression can be lifted by an operator, an erasure is a
 * request to be forgotten — so it is checked first and counted separately.
 *
 * `previewImport` never calls `tesserixTx` and issues no INSERT/UPDATE at
 * all — the "dry run writes nothing" guarantee is structural (there is no
 * write statement anywhere in the function to accidentally reach), not a
 * single early return a later edit could route around.
 */

/**
 * An existing organisation this row's contact details already match, if
 * any — checked against `crm_contacts`' own unique indexes
 * (`crm_contacts_email_lower_uq` on lower(email), migration 0019;
 * `crm_contacts_instagram_lower_uq` on lower(instagram_handle), migration
 * 0023 — over a column 0023's `crm_contacts_normalize_trg` keeps in the
 * same canonical form `normalizeInstagramHandle` produces, so the index
 * constrains what this function actually looks up), the same two keys
 * `crm_suppressions` is keyed on. A row that
 * matches gets counted, not silently merged: this import does not attempt
 * to update an existing organisation's details, only to avoid creating a
 * duplicate one.
 *
 * The handle index arrived late (issue #215: 0019 shipped it plain, not
 * unique, while this comment and the import's dedup both assumed
 * otherwise), so the `ORDER BY` below is not redundant with it. With both
 * indexes in place at most one row can match either clause, and the order
 * decides nothing; it exists for the case where they are somehow not — a
 * database predating 0023, or one where the index was dropped — so that a
 * wrong answer is at least the SAME wrong answer on every call. `created_at`
 * first because the oldest contact is the one earlier imports already
 * resolved this handle to, so answers stay stable as newer rows arrive
 * rather than flipping to whichever duplicate landed last; `id` as
 * tie-break because `created_at` has no uniqueness of its own and two
 * contacts written in the same transaction share it exactly.
 *
 * Exported (not `previewImport`/`commitImport`-only) so a caller can
 * directly test that the `query` override — the mechanism Ruling 23 relies
 * on — actually takes precedence over the module's own `tesserixQuery`,
 * without having to drive the whole of `commitImport` to observe it.
 *
 * `query` defaults to `tesserixQuery`: see `isSuppressed`'s doc comment for
 * why `commitImport` passes its transaction's own scoped query instead.
 */
export async function findMatchingOrganisationId(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<string | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.email) {
    params.push(normalizeContactEmail(input.email));
    clauses.push(`lower(email) = lower($${params.length})`);
  }
  if (input.instagramHandle) {
    params.push(normalizeInstagramHandle(input.instagramHandle));
    clauses.push(`lower(instagram_handle) = lower($${params.length})`);
  }
  if (clauses.length === 0) return null;

  const rows = await query<{ organisation_id: string }>(
    `SELECT organisation_id FROM crm_contacts WHERE ${clauses.join(" OR ")}
      ORDER BY created_at, id LIMIT 1`,
    params,
  );
  return rows[0]?.organisation_id ?? null;
}

/**
 * The erasure register (#226, migration 0041).
 *
 * `eraseContact` nulls `email` and `instagram_handle`, and
 * `findMatchingOrganisationId` above matches on exactly those two columns. So
 * before this, a re-import of an erased person matched NOTHING and
 * `commitImport` created them again as a fresh organisation with a fresh
 * opportunity — the erasure silently undone, and the new row carrying no
 * trace that a request had ever been made. `crm_contacts.erased_at` had
 * existed since migration 0024 and was written by nobody's reader; 0024's own
 * header predicted this exact failure and the read half never shipped.
 *
 * The register holds a keyed HMAC of each destroyed identifier and nothing
 * else — no contact id, no organisation id, no plaintext. See
 * `crm-erasure-hash.ts` for why HMAC rather than a bare digest, and migration
 * 0041 for why the table deliberately has no foreign key to anything.
 */

/**
 * Thrown when an import cannot check the erasure register.
 *
 * This exists for exactly one situation: `CRM_ERASURE_HASH_KEY` is unset AND
 * the register is not empty. Both halves matter.
 *
 * With no key and an EMPTY register there is nothing wrong — `eraseContact`
 * throws without a key, so no hash can ever have been recorded, so there is
 * nothing an import could have matched and nothing it can get wrong. The two
 * halves of the feature cannot disagree, because neither of them runs.
 *
 * With no key and a NON-empty register the picture inverts: somebody's
 * erasure IS recorded, and this import would compute no hashes, match
 * nothing, and re-create them — while cheerfully reporting `skippedErased: 0`
 * as though it had checked. That is the silent no-op the whole feature exists
 * to prevent, and it is not something an operator could ever notice from the
 * summary card. Refusing the import outright is the only honest answer: it is
 * recoverable in one deploy, and importing is recoverable only by erasing the
 * same person a second time.
 *
 * Operator-facing (see `mapError` in `lib/crm-write.ts`) and it names the
 * variable, because the remedy is to provision it and retry.
 */
export class ErasureCheckUnavailableError extends Error {
  constructor() {
    super(
      `This import cannot run: ${ERASURE_HASH_KEY_ENV} is not configured, but contacts have ` +
        `already been erased. Importing without it would re-create people who asked to be ` +
        `forgotten. Set the variable and try again.`,
    );
    this.name = "ErasureCheckUnavailableError";
  }
}

/**
 * A once-per-batch guard that refuses the import if the erasure check could
 * not mean anything.
 *
 * Returns a function rather than being one, for two reasons that both matter:
 *
 * ONCE per batch, not once per row. The question — "is the register non-empty
 * while the key is missing?" — has one answer for the whole import, and
 * asking it 500 times against a `max: 2` pool is the connection pressure
 * Ruling 23 exists to avoid.
 *
 * LAZILY, not up front. `previewImport`'s guarantee is that a batch of rows
 * with nothing to identify them touches the database not at all — pinned by
 * `crm-repo.test.ts` — and hoisting this to the top of the loop would break
 * it for no gain: with no row to check, there is nothing the register could
 * have been consulted about.
 *
 * The probe itself only runs on the branch where the key is missing, which is
 * never in a correctly configured deployment. `LIMIT 1` because the count is
 * irrelevant; the question is whether the register is empty.
 *
 * Both `previewImport` and `commitImport` use it, for the same reason both
 * call `isSuppressed`: a preview that quietly ignored the register would
 * promise an operator N creations that the commit must then refuse.
 *
 * The returned function throws {@link ErasureCheckUnavailableError}.
 */
function erasureCheckGuard(query: TxQuery): () => Promise<void> {
  let settled = false;
  return async () => {
    if (settled) return;
    settled = true;
    if (isErasureHashKeyConfigured()) return;
    const rows = await query<{ one: number }>(
      `SELECT 1 AS one FROM crm_erased_identifiers LIMIT 1`,
      [],
    );
    if (rows.length > 0) throw new ErasureCheckUnavailableError();
  };
}

/**
 * Whether either identifier belongs to someone who asked to be forgotten.
 *
 * Shaped like `isSuppressed` on purpose — same `SuppressionCheck` input, same
 * `query` override, same `false` for a row carrying neither key — because the
 * two run back to back on every import row and a reader should not have to
 * hold two different calling conventions in mind to see that both are
 * checked.
 *
 * `query` defaults to `tesserixQuery`; `commitImport` passes its
 * transaction's own scoped query for the reasons in `isSuppressed`'s comment
 * (Ruling 23). Here the connection argument is the operative one: this is a
 * pure read of a table the import never writes, but acquiring a second pooled
 * client per row against `max: 2` is how two concurrent commits starve each
 * other out of the pool.
 *
 * Returns `false` — rather than throwing — when the key is unset. That is not
 * a fail-open: {@link assertErasureCheckable} has already refused the batch if
 * a single hash exists that this could have missed. Splitting it that way is
 * what keeps the per-row path free of a check that can only ever have one
 * answer for the whole batch.
 */
export async function isErased(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<boolean> {
  if (!isErasureHashKeyConfigured()) return false;
  const hashes = erasureHashes(input);
  if (hashes.length === 0) return false;

  const rows = await query<{ identifier_hash: string }>(
    // `= ANY($1::text[])`, one round trip, rather than a clause per
    // identifier: the parameter count then does not depend on which of the
    // two keys the row happens to carry, so the statement text is identical
    // for every row and the planner sees one prepared shape. The explicit
    // cast is not optional — without it the driver's array literal arrives
    // as `unknown` and the comparison against a `text` column is ambiguous.
    `SELECT identifier_hash FROM crm_erased_identifiers WHERE identifier_hash = ANY($1::text[]) LIMIT 1`,
    [hashes],
  );
  return rows.length > 0;
}

export interface ImportPreview {
  toCreate: number;
  matchedExisting: number;
  skippedSuppressed: number;
  /**
   * Rows refused because the person asked to be forgotten (#226).
   *
   * A SEPARATE counter from `skippedSuppressed`, never folded into it, even
   * though both mean "we did not create this row". They are different legal
   * requests with different remedies, and the import card's copy for the
   * suppressed case tells the operator to remove the suppression — advice
   * that is actively wrong for someone who asked to be erased, and which an
   * operator could act on. A merged counter would put that wrong advice in
   * front of them with no way to tell the two apart.
   */
  skippedErased: number;
  malformed: number;
  /** The rows that matched an existing organisation, in order — cheap to
   *  keep (no extra query: `commitImport`/`previewImport` already has the
   *  row in hand at the point it decides `matchedExisting`) and is what lets
   *  the UI name which businesses' CSV data was left on the floor, rather
   *  than reporting a bare count an operator can misread as "updated". */
  matchedRows: readonly ImportRow[];
}

/** Normalised keys a row could be deduped on, namespaced (`email:`/`ig:`)
 *  so an email and an Instagram handle can never collide with each other's
 *  normal form. Shared by `previewImport`'s in-batch dedup set below — the
 *  same trim/lowercase (email) and `normalizeInstagramHandle` (handle) the
 *  database's own unique indexes and `isSuppressed` use, so this can never
 *  disagree with what a real insert would collide on — true of the handle
 *  only since migration 0023, which added BOTH halves it needs:
 *  `crm_contacts_instagram_lower_uq`, and the
 *  `crm_contacts_normalize_trg` trigger that guarantees the column holds the
 *  canonical form the index is expressed over. Before 0023 this set was the
 *  ONLY thing stopping two contacts sharing one canonical handle (issue
 *  #215); the index alone would have been only a partial backstop, since
 *  `lower('@bondibaker')` is `@bondibaker` and would have coexisted happily
 *  with a stored `bondibaker`. */
function importRowKeys(row: ImportRow): string[] {
  const keys: string[] = [];
  if (row.email) keys.push(`email:${normalizeContactEmail(row.email)}`);
  if (row.instagramHandle) keys.push(`ig:${normalizeInstagramHandle(row.instagramHandle)}`);
  return keys;
}

/**
 * Dry-run a batch of parsed CSV rows: how many would create a new
 * organisation, how many match one that already exists, how many are
 * suppressed, and how many carry nothing usable at all. Writes nothing —
 * see the module comment.
 *
 * Important 1 (review round 2): earlier this ran entirely on
 * `tesserixQuery` with no memory across rows, on the theory that a preview
 * has no transaction of its own for a later row to see. That's still true
 * of the DATABASE, but it left a gap this function itself has to close: two
 * rows in the same preview sharing an email — "ordinary content for a
 * scraped leads sheet" is this module's own description of that input —
 * both previewed as `toCreate`, while `commitImport` (Ruling 23) correctly
 * resolves the second as `matchedExisting`. Same input, two different
 * numbers, on the one page whose entire premise is "preview what this would
 * do." `seenKeys` is this function's own in-memory memory of every row IT
 * has already decided to create in THIS SAME preview — not a database read,
 * so it costs nothing extra, and it is what lets a preview agree with what
 * `commitImport` will actually do without needing a transaction to prove it.
 */
export async function previewImport(rows: readonly ImportRow[]): Promise<ImportPreview> {
  let toCreate = 0;
  let matchedExisting = 0;
  let skippedSuppressed = 0;
  let skippedErased = 0;
  let malformed = 0;
  const matchedRows: ImportRow[] = [];
  const seenKeys = new Set<string>();
  const ensureErasureCheckable = erasureCheckGuard(tesserixQuery);

  for (const row of rows) {
    if (!isUsableImportRow(row)) {
      malformed++;
      continue;
    }
    const check: SuppressionCheck = { email: row.email, instagramHandle: row.instagramHandle };
    // Erasure BEFORE suppression, here and in `commitImport`, and the order
    // is load-bearing rather than arbitrary. Someone can be on both lists,
    // and whichever check runs first decides which counter — and therefore
    // which remedy — the operator is shown. "Remove the suppression" is the
    // wrong instruction for a person who asked to be forgotten, and it is an
    // instruction an operator can actually carry out. The two paths run the
    // checks in the same order so they can never report the same file
    // differently.
    await ensureErasureCheckable();
    if (await isErased(check)) {
      skippedErased++;
      continue;
    }
    if (await isSuppressed(check)) {
      skippedSuppressed++;
      continue;
    }

    const keys = importRowKeys(row);
    if (keys.some((key) => seenKeys.has(key))) {
      // An earlier row in this SAME batch already claimed this identity —
      // exactly the case `commitImport` resolves via the transaction seeing
      // its own uncommitted insert (Ruling 23). No database round trip
      // needed to know the answer: this preview already decided to create
      // that row.
      matchedExisting++;
      matchedRows.push(row);
      continue;
    }

    const matchedId = await findMatchingOrganisationId(check);
    if (matchedId) {
      matchedExisting++;
      matchedRows.push(row);
    } else {
      toCreate++;
      // Registered only on the branch that will actually create something
      // new — mirrors `commitImport`, where only a row that reaches its own
      // `crm_contacts` insert becomes visible to a later row's lookup. A
      // row that matched an existing organisation doesn't need to be
      // remembered here: any later row sharing its identity will
      // independently find the same durably-committed match via
      // `findMatchingOrganisationId`.
      keys.forEach((key) => seenKeys.add(key));
    }
  }

  return { toCreate, matchedExisting, skippedSuppressed, skippedErased, malformed, matchedRows };
}

export interface ImportResult {
  importId: string;
  created: number;
  matchedExisting: number;
  skippedSuppressed: number;
  /** Rows refused because the person asked to be forgotten (#226) — see
   *  `ImportPreview.skippedErased` for why this is never folded into
   *  `skippedSuppressed`. The same file must produce the same number here as
   *  it does at preview; `crm-repo.integration.test.ts` pins that. */
  skippedErased: number;
  malformed: number;
  /**
   * Rows that WERE created, but whose `website_url` cell failed
   * `isSafeWebsiteUrl` and was stored as NULL. Deliberately not folded into
   * `malformed` — that counter means "no organisation was created for this
   * row" — but it cannot go unreported either: there is no organisation edit
   * surface, so an operator who is never told cannot ever put the address
   * back. Zero for an import where every URL was fine, which is the common
   * case and reads as such.
   */
  droppedWebsiteUrls: number;
  /**
   * Count CELLS (not rows) whose `followers`/`posts` value was not a plain
   * whole number and was stored as NULL — `1.2k`, `n/a`, a blank-but-present
   * `-`. One row with both cells bad counts twice.
   *
   * Same contract as `droppedWebsiteUrls` and separate from `malformed` for
   * the same reason: the row WAS created, so folding it into a counter that
   * means "no organisation was created for this row" would make that counter
   * mean two things. The two count columns share one counter because they
   * share one remedy — correct the sheet, import again — and splitting them
   * would put two numbers on the summary card that an operator can only ever
   * act on together.
   */
  droppedCountCells: number;
  /** Rows created with their `metadata` cell dropped to `{}` because it was
   *  not a JSON object. Counted for the same reason as the above: nothing
   *  else would tell the operator the retained scrape output was lost. */
  droppedMetadataCells: number;
  matchedRows: readonly ImportRow[];
}

/**
 * What a scrape cell became, and whether anything was lost turning it into
 * that. The `dropped` half is why these return a pair rather than a bare
 * value: a refused cell and an absent cell both store nothing, and only the
 * refused one is worth reporting to the operator.
 */
interface CellOutcome<T> {
  value: T;
  dropped: number;
}

function countCell(raw: string | undefined): CellOutcome<number | null> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null, dropped: 0 };
  const value = parseCountCell(trimmed);
  return { value, dropped: value === null ? 1 : 0 };
}

function metadataCell(raw: string | undefined): CellOutcome<Record<string, unknown>> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: {}, dropped: 0 };
  const value = parseMetadataCell(trimmed);
  return { value: value ?? {}, dropped: value === null ? 1 : 0 };
}

/**
 * Commit a batch of parsed CSV rows: one `crm_imports` row for the batch,
 * one `crm_organisations`/`crm_contacts`/`crm_opportunities` triple per row
 * that creates something new, all in a single transaction — either the
 * whole batch lands or none of it does, so a failure partway through never
 * leaves an orphaned `crm_imports` row with no organisations to show for it.
 *
 * Re-checks suppression AND the erasure register per row, exactly like
 * `previewImport` — see the module comment for why a stale preview cannot be
 * trusted to have already covered either. A row matching an existing organisation is counted but not
 * written, same as at preview: this does not merge into or update the
 * existing row.
 *
 * `lawfulBasis` is declared ONCE FOR THE BATCH (#248), not per row, and has
 * no default. A CSV of scraped profiles has one answer to "why may we hold
 * these people" for the whole file — the operator who chose the file is the
 * only one who knows it, and a per-row column would ask them to repeat a
 * single decision N times and let rows disagree. It is rejected here as well
 * as at the action, on the same reasoning `insertContact` states.
 * `source` is `'import'` for every contact created here (matching the
 * `crm_opportunities.source` this function already writes) and `sourced_at`
 * is the commit's own `now()`.
 *
 * `product` is never set: an imported lead was never matched to a product
 * (migration 0019's comment on `crm_opportunities.product`), and every
 * created opportunity lands at stage `new`, the one stage the
 * `crm_opp_product_required_when_qualified` CHECK allows without one.
 *
 * `totalRows`, when supplied, is the size of the ORIGINAL file — including
 * rows `parseImportCsv` already dropped as malformed before this function
 * ever saw them (`lib/crm.ts`'s `ParsedImport.malformed`). Without it,
 * `crm_imports.row_count` would under-report the file by exactly that many
 * rows. Defaults to `rows.length` so a caller that only has the parsed rows
 * (every existing test, and any future direct caller) still gets a
 * self-consistent record.
 */
export async function commitImport(
  rows: readonly ImportRow[],
  actor: string,
  lawfulBasis: LawfulBasis,
  filename?: string,
  totalRows: number = rows.length,
): Promise<ImportResult> {
  if (!isSelectableLawfulBasis(lawfulBasis)) {
    throw new Error(`commitImport: ${String(lawfulBasis)} is not a selectable lawful basis`);
  }
  return tesserixTx(async (query) => {
    let created = 0;
    let matchedExisting = 0;
    let skippedSuppressed = 0;
    let skippedErased = 0;
    let malformed = 0;
    let droppedWebsiteUrls = 0;
    let droppedCountCells = 0;
    let droppedMetadataCells = 0;
    const matchedRows: ImportRow[] = [];

    const ensureErasureCheckable = erasureCheckGuard(query);

    const importRows = await query<{ id: string }>(
      `INSERT INTO crm_imports (filename, created_by) VALUES ($1, $2) RETURNING id`,
      [filename ?? null, actor],
    );
    const importId = importRows[0].id;

    for (const row of rows) {
      if (!isUsableImportRow(row)) {
        malformed++;
        continue;
      }

      const check: SuppressionCheck = { email: row.email, instagramHandle: row.instagramHandle };
      // Ruling 23: both lookups run on `query` — the transaction's OWN
      // scoped client, not the module-level `tesserixQuery` (a separate
      // pooled connection). Two things ride on this, together, not either
      // alone:
      //
      // (1) A row created earlier in THIS SAME loop must be visible to a
      //     later row's dedup check. Two CSV rows sharing an email is
      //     ordinary content for a scraped leads sheet; on a separate
      //     connection the second row's lookup would see nothing yet
      //     committed, attempt its own `crm_contacts` insert, and trip
      //     `crm_contacts_email_lower_uq` — rolling the ENTIRE batch back on
      //     what should just resolve as `matchedExisting`.
      // (2) No second pooled connection is acquired per row at all. Against
      //     `max: 2` (tesserix.ts), the old shape held one client for the
      //     transaction and tried to acquire a second, twice per row; two
      //     operators committing concurrently could each hold one client
      //     and starve the other out of the pool entirely.
      // Erasure first, then suppression — the same order `previewImport`
      // uses, for the reason documented there: the order decides which
      // counter, and therefore which remedy, the operator is shown for a
      // person who is on both lists.
      await ensureErasureCheckable();
      if (await isErased(check, query)) {
        skippedErased++;
        continue;
      }
      if (await isSuppressed(check, query)) {
        skippedSuppressed++;
        continue;
      }

      const matchedId = await findMatchingOrganisationId(check, query);
      if (matchedId) {
        matchedExisting++;
        matchedRows.push(row);
        continue;
      }

      const name = row.name?.trim() || row.email?.trim() || row.instagramHandle?.trim();
      // A hostile `website_url` cell (`javascript:alert(1)`, `data:...`) is
      // one bad field on an otherwise usable row — not a reason to reject
      // the whole row, and certainly not a reason to throw mid-loop and roll
      // back every row already committed in this batch (Ruling 23's
      // same-transaction guarantee cuts both ways: one bad row must not cost
      // the others). Stored as NULL instead, exactly like the column's
      // existing "blank cell" handling one line below.
      //
      // Counted, though, in its own `droppedWebsiteUrls` — not in
      // `malformed`, which means "no organisation was created for this row"
      // (see the `isUsableImportRow` check above) and would come to mean two
      // things at once. The count is what makes the drop recoverable at all:
      // there is no organisation edit surface anywhere in the console, so a
      // silently dropped address is gone until the row is re-imported, and an
      // operator who is not told has no way to know a re-import is owed.
      const trimmedWebsiteUrl = row.websiteUrl?.trim() || null;
      const websiteUrl =
        trimmedWebsiteUrl && isSafeWebsiteUrl(trimmedWebsiteUrl) ? trimmedWebsiteUrl : null;
      if (trimmedWebsiteUrl && !websiteUrl) {
        droppedWebsiteUrls++;
      }
      // `country` is derived from `location` at insert time, not left for a
      // later backfill to catch: a column no writer maintains decays into a
      // filter that silently stops matching new rows (see migration 0025).
      // `countryFromLocation` never guesses — an unmappable location yields
      // NULL, the same as it would for the one-shot backfill.
      const location = row.location?.trim() || null;
      const orgRows = await query<{ id: string }>(
        `INSERT INTO crm_organisations (name, website_url, location, country, category, tags, import_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          name,
          websiteUrl,
          location,
          countryFromLocation(location),
          row.category ?? [],
          row.tags ?? [],
          importId,
        ],
      );
      const organisationId = orgRows[0].id;

      // The scrape columns (#235). Each bad cell is stored as NULL (or `{}`
      // for the bag) and counted, exactly as `website_url` above: one
      // unusable cell must neither abort the batch nor silently become a
      // `0` that files the organisation in a follower band it is not in.
      const followersCount = countCell(row.followersCount);
      const postsCount = countCell(row.postsCount);
      droppedCountCells += followersCount.dropped + postsCount.dropped;
      const metadata = metadataCell(row.metadata);
      droppedMetadataCells += metadata.dropped;

      await query(
        // #248: `source`/`sourced_at`/`lawful_basis` land on the same INSERT
        // as the personal columns, not on a follow-up UPDATE — a row that
        // exists for even one statement without the justification for
        // holding it is the state this issue is about.
        `INSERT INTO crm_contacts
           (organisation_id, name, email, phone, instagram_handle, is_primary,
            biography, followers_count, posts_count, metadata,
            source, sourced_at, lawful_basis)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9::jsonb, $10, now(), $11)`,
        [
          organisationId,
          row.name?.trim() || null,
          row.email ? normalizeContactEmail(row.email) : null,
          row.phone?.trim() || null,
          row.instagramHandle ? normalizeInstagramHandle(row.instagramHandle) : null,
          row.biography?.trim() || null,
          followersCount.value,
          postsCount.value,
          JSON.stringify(metadata.value),
          CONTACT_SOURCE.import,
          lawfulBasis,
        ],
      );

      await query(
        `INSERT INTO crm_opportunities (organisation_id, product, stage, source)
         VALUES ($1, NULL, 'new', $2)`,
        [organisationId, "import"],
      );

      created++;
    }

    // Reconciled by construction: `skippedCount` is defined as "everything
    // that wasn't created" rather than summed from the individual counters,
    // so `row_count - skipped_count === created` can never drift the way it
    // did when `skipped_count` was `skippedSuppressed + malformed` alone
    // (silently excluding `matchedExisting`, which is equally "not
    // created").
    const skippedCount = totalRows - created;
    await query(`UPDATE crm_imports SET row_count = $2, skipped_count = $3 WHERE id = $1`, [
      importId,
      totalRows,
      skippedCount,
    ]);

    return {
      importId,
      created,
      matchedExisting,
      skippedSuppressed,
      skippedErased,
      malformed,
      droppedWebsiteUrls,
      droppedCountCells,
      droppedMetadataCells,
      matchedRows,
    };
  });
}
