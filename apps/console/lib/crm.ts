/** Pipeline order. `won`/`lost` are terminal. */
export const CRM_STAGES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export const CRM_ACTIVITY_KINDS = [
  "note", "dm_sent", "dm_received", "email_sent", "email_received",
  "call", "stage_change", "assigned",
] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

/**
 * The kinds an operator may author directly, through a free-text note/log
 * action. `stage_change` and `assigned` are system-authored: they are
 * written only by the code that performs the thing they describe
 * (`advanceStage`, an owner-assignment write), each inside the same
 * transaction as that change. A generic "log an activity" action that
 * accepted every kind could write a `stage_change` row with an arbitrary
 * body and no stage having moved — the timeline that funnel measurement
 * reads would then no longer be solely produced by `advanceStage`, which is
 * the whole guarantee that function exists to hold.
 */
export const HUMAN_ACTIVITY_KINDS = [
  "note", "dm_sent", "dm_received", "email_sent", "email_received", "call",
] as const satisfies readonly CrmActivityKind[];
export type HumanActivityKind = (typeof HUMAN_ACTIVITY_KINDS)[number];

/**
 * Activity kinds that record a real touch between us and the business —
 * outbound or inbound. Logging one of these means contact happened, so it is
 * what `last_contacted_at` (the drift clock the queue reads) must move for,
 * and it is what the composer offers a follow-up after.
 *
 * `note`, `stage_change` and `assigned` are deliberately absent: they are
 * things WE did to our own record, not contact with anyone. Counting an
 * internal note as contact would silently reset the drift clock on an
 * organisation nobody has actually spoken to — the exact false "recently
 * contacted" the drift rule exists to expose.
 *
 * Here rather than in `crm-repo.ts` because both ends need the same answer:
 * the repo decides whether to move the clock, the composer decides whether
 * to prompt for a next action, and two copies of this list are two chances
 * for the UI to promise something the write path does not do.
 */
export const CONTACT_ACTIVITY_KINDS = [
  "dm_sent", "dm_received", "email_sent", "email_received", "call",
] as const satisfies readonly CrmActivityKind[];

export function isContactActivityKind(value: string): boolean {
  return (CONTACT_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** `won`/`lost` are terminal — the deal is not being worked any more. */
export function isOpenStage(stage: CrmStage): boolean {
  return stage !== "won" && stage !== "lost";
}

export function isCrmStage(value: string): value is CrmStage {
  return (CRM_STAGES as readonly string[]).includes(value);
}

export function isCrmActivityKind(value: string): value is CrmActivityKind {
  return (CRM_ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isHumanActivityKind(value: string): value is HumanActivityKind {
  return (HUMAN_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** `product` is required from `qualified` onward. Mirrors the CHECK constraint
 *  in migration 0019 so the boundary rejects before the database has to. */
export function requiresProduct(stage: CrmStage): boolean {
  return stage !== "new" && stage !== "contacted";
}

/** Days of silence before a no-next-action opportunity counts as "drifting"
 *  in the queue. A guess about sales rhythm, not a measured threshold — there
 *  is no usage data yet. Revisit once real queues exist to tune against. */
export const DRIFT_DAYS = 14;

/**
 * How far ahead logging a piece of outbound contact pushes the next action
 * (#502).
 *
 * Comfortably inside `DRIFT_DAYS` (14), and that relationship is the whole
 * reason the number exists: a lead that has just been worked should come back
 * for a chase before it falls past the drift threshold and gets re-discovered
 * as neglected. A default, not a rule — every caller lets the operator move or
 * remove it.
 *
 * Four rather than the three the composer's prompt used to prefill. It is one
 * number now because it was two: `crm-outreach.ts` scheduled four days out and
 * the follow-up prompt suggested three, so an operator who accepted the offer
 * silently moved the date the write path had just chosen, and nobody could say
 * which of the two was the product's answer. Four is the one that was already
 * reasoned about (a cold DM waits on a stranger's reply, not on a conversation
 * already underway), so it is the one that survived.
 */
export const NEXT_ACTION_DAYS = 4;

/**
 * The contact kinds that are US reaching OUT, as opposed to a reply arriving.
 *
 * TWO RULES READ THIS LIST, and they must read the same one.
 *
 * 1. The do-not-contact gate (`logActivity`). Only outbound kinds are refused
 *    for a suppressed organisation: recording that someone emailed *us* is not
 *    outreach, and refusing to record it would destroy the record of the very
 *    contact that most needs one.
 * 2. The follow-up clock (#502). Outbound schedules a chase
 *    `NEXT_ACTION_DAYS` out; inbound is due NOW, because a reply is the moment
 *    to act. Neither leaves `next_action_at` null, which is the definition of
 *    Drifting.
 *
 * `note` is not here and not a contact kind at all — it is something we did to
 * our own record, not contact with anyone.
 *
 * WHY `call` COUNTS AS OUTBOUND. It is the genuinely ambiguous one: the CRM has
 * no `call_received`, so an inbound call is logged with the same kind as a cold
 * one. Three reasons it sits here anyway. First, this list already classified
 * `call` as outbound for the suppression gate before #502 existed; a second,
 * contradictory classification of the same kind — outbound for one rule,
 * inbound for the other — is exactly the pair of copies that stops agreeing in
 * a single commit. Second, the costs are not symmetric: a follow-up the
 * operator did not want costs one click to clear, while no follow-up files the
 * lead into Drifting, which is the defect this is fixing. Third, a call that
 * did land and was hot is a case the operator is already in front of — they
 * pull the date forward in the same interaction. The ambiguous case is the one
 * where nothing further has been agreed, and that case wants a chase.
 */
export const OUTBOUND_ACTIVITY_KINDS = [
  "dm_sent", "email_sent", "call",
] as const satisfies readonly CrmActivityKind[];

export function isOutboundActivityKind(value: CrmActivityKind): boolean {
  return (OUTBOUND_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** Nine in the morning: a follow-up days out wants a time of day an operator
 *  would actually start work at, not whatever minute they happened to log the
 *  DM at. */
const NEXT_ACTION_HOUR = 9;

/**
 * When contact of this kind schedules the next action for, in JavaScript.
 *
 * The write path states the same rule in SQL (`nextActionAssignment`,
 * crm-repo.ts) because a `CASE` expression cannot call a TypeScript function.
 * This copy exists so the composer can PREFILL the control the operator uses to
 * change it: a prompt offering a different date from the one just written would
 * be describing a schedule the database does not have. Both copies are asserted
 * against the same `NEXT_ACTION_DAYS`, on their own side of the seam.
 *
 * Outbound lands on 09:00 local; inbound lands on the instant the reply was
 * logged. The hour is a nicety for a date days away — for "now" it would be a
 * lie, and possibly one in the past.
 */
export function defaultNextActionAt(kind: CrmActivityKind, now: Date = new Date()): Date {
  if (!isOutboundActivityKind(kind)) return new Date(now);
  const at = new Date(now);
  at.setDate(at.getDate() + NEXT_ACTION_DAYS);
  at.setHours(NEXT_ACTION_HOUR, 0, 0, 0);
  return at;
}


/**
 * CSV import (Task 8).
 *
 * `parseImportCsv` is pure — no database, no session — so it can run either
 * in the browser (parsing a file the operator just picked) or on the server,
 * and so it is testable without a database mock. The DB-dependent halves of
 * import, `previewImport`/`commitImport`, live in `lib/db/crm-repo.ts`
 * instead, next to `isSuppressed`, which both call.
 */

/** One row of an import, after CSV parsing. Every field is optional — a
 *  usable row needs only enough to identify who it is about
 *  (`isUsableImportRow`), and `product` is never a field here: an imported
 *  lead was never matched to a product, and inventing one at import time
 *  fabricates attribution the funnel later reports as fact (migration
 *  0019's comment on `crm_opportunities.product`). */
export interface ImportRow {
  name?: string;
  email?: string;
  instagramHandle?: string;
  phone?: string;
  websiteUrl?: string;
  location?: string;
  category?: readonly string[];
  tags?: readonly string[];
  /**
   * The three scrape columns `crm_contacts` has carried since migration 0019
   * (#235), plus the raw bag 0027 adds. All four are the RAW cell text, not a
   * parsed value — exactly like `websiteUrl`, and for the same reason: the
   * writer that refuses a bad cell is also the one that has to COUNT the
   * refusal (`commitImport`'s `droppedCountCells` / `droppedMetadataCells`),
   * and a value parsed here would arrive as `undefined`, indistinguishable
   * from a column the operator never supplied.
   */
  biography?: string;
  followersCount?: string;
  postsCount?: string;
  /** Raw JSON text for `crm_contacts.metadata`. See `parseMetadataCell`. */
  metadata?: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  malformed: number;
  /** Set when the FILE, not a row, could not be parsed — the whole thing is
   *  refused and `rows` is empty. Operator-facing copy; see
   *  `UNBALANCED_QUOTES_MESSAGE`. */
  rejected?: string;
}

export const UNBALANCED_QUOTES_MESSAGE =
  "This file has an unclosed quote — a quoted value probably spans more than one line. " +
  "Fix the quoting (or re-export without line breaks inside cells) and try again.";

/**
 * A row worth importing has at least one field that could identify who it
 * is about — a name, an email, or an Instagram handle. A row with none of
 * those carries nothing `previewImport`/`commitImport` could act on: no
 * suppression key to check, nothing to dedupe against, nothing to name an
 * organisation with. Exported so the repo layer applies exactly this rule,
 * not a second copy that could drift from it.
 */
export function isUsableImportRow(row: ImportRow): boolean {
  return Boolean(row.name?.trim() || row.email?.trim() || row.instagramHandle?.trim());
}

/** Column header (lowercased) -> `ImportRow` field. A column not listed
 *  here is ignored, not an error — an operator's export may carry extra
 *  columns (an internal id, a scrape timestamp) this import has no use for. */
const IMPORT_COLUMN_MAP: Record<string, keyof ImportRow> = {
  name: "name",
  email: "email",
  instagram: "instagramHandle",
  instagram_handle: "instagramHandle",
  phone: "phone",
  website: "websiteUrl",
  website_url: "websiteUrl",
  location: "location",
  category: "category",
  tags: "tags",
  followers: "followersCount",
  followers_count: "followersCount",
  posts: "postsCount",
  posts_count: "postsCount",
  bio: "biography",
  biography: "biography",
  metadata: "metadata",
};

/**
 * Largest value Postgres's `integer` holds — the declared type of both
 * `crm_contacts.followers_count` and `.posts_count`. Checked here rather
 * than left to the INSERT: an out-of-range value raises at the database and
 * would abort the whole batch, which is the one outcome a single bad cell
 * must never cause.
 */
const MAX_COUNT_VALUE = 2_147_483_647;

/**
 * A follower/post count cell, or `null` if the cell is not a plain whole
 * number in range.
 *
 * Deliberately strict. `1.2k` and `1,200` are refused rather than
 * interpreted: `1.2k` is anywhere in 1,200–1,299 and `1,200` is a thousands
 * separator in one locale and a decimal point in another. Once stored, a
 * guessed count is indistinguishable from a scraped one, and these columns
 * are a filter axis — a guess would put an organisation in a follower band
 * it does not belong to. `commitImport` stores NULL for a refused cell and
 * counts it, so the operator can correct the sheet and re-import; that is a
 * recoverable outcome, and a silent `0` is not.
 */
export function parseCountCell(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_COUNT_VALUE ? value : null;
}

/**
 * A `crm_contacts.metadata` cell, or `null` if it is not a JSON object.
 *
 * Objects only — not arrays, not scalars. The bag exists so a key can later
 * be promoted into its own column when it becomes a filter axis (migration
 * 0027), and only an object has keys to promote. A refused cell is counted
 * by `commitImport` for the same reason a refused count is.
 */
export function parseMetadataCell(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const LIST_FIELDS: ReadonlySet<keyof ImportRow> = new Set(["category", "tags"]);

/**
 * Splits one CSV line into cells, honouring double-quoted fields (which may
 * contain a comma, or an escaped `""` for a literal quote). Does not handle
 * a quoted field spanning multiple physical lines — an acceptable
 * simplification for the hand-exported leads sheets this import targets.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function splitList(value: string): string[] {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function cellsToRow(header: readonly string[], cells: readonly string[]): ImportRow {
  const row: Record<string, unknown> = {};
  header.forEach((column, index) => {
    const field = IMPORT_COLUMN_MAP[column];
    if (!field) return;
    // Trimmed here, not left to the caller: CSV cells routinely carry stray
    // whitespace, which is exactly what would make a later suppression
    // lookup miss a real match (see crm-repo.ts's `isSuppressed`).
    const raw = (cells[index] ?? "").trim();
    if (raw === "") return;
    row[field] = LIST_FIELDS.has(field) ? splitList(raw) : raw;
  });
  return row as ImportRow;
}

/**
 * Parses a CSV export into import-ready rows.
 *
 * A fully blank line is skipped silently and not counted as malformed — it
 * is not a row at all, just incidental whitespace in the file. A line that
 * parses but ends up with nothing `isUsableImportRow` accepts IS malformed:
 * counted, not silently dropped, so an operator previewing an import sees
 * that rows were lost rather than assuming every line in the file was
 * imported.
 */
/**
 * Upper bound on rows accepted by a single import batch, enforced at the
 * action layer (`import/actions.ts`) before `previewImportAction` or
 * `commitImportAction` ever reaches the database.
 *
 * Ruling 24 (review round 2): derived from `tesserix.ts`'s own numbers, not
 * picked. Per created row `commitImport` runs up to 2 SELECTs + 3 INSERTs,
 * all awaited in series, on ONE of the pool's `max: 2` connections — a
 * 2,000-row commit is ~10,000 serial round trips (5-20s in-cluster) while
 * `connectionTimeoutMillis` is 5,000 and the pool comment already warns
 * that two concurrent holders queue a third caller behind them. A
 * max-size import could therefore exceed the connection timeout for
 * unrelated console reads waiting on the same pool — the exact failure
 * this cap exists to prevent, just slower. 500 rows is ~2,500 round trips,
 * comfortably inside that budget even with a second commit running
 * concurrently.
 *
 * Batched multi-row INSERTs (one round trip for N rows instead of N) are
 * the real fix for the underlying throughput limit, but are a redesign of
 * `commitImport`'s write shape, not a cap — out of scope for this round.
 */
export const MAX_IMPORT_ROWS = 500;

/** Cap on a filename before it flows into an audit `target` or
 *  `crm_imports.filename` — a filesystem doesn't bound this, and an
 *  operator-supplied filename reaching a server action is untrusted input
 *  like any other cell in the file. */
export const MAX_IMPORT_FILENAME_LENGTH = 255;

/**
 * Trims and truncates a filename to `MAX_IMPORT_FILENAME_LENGTH`.
 * `undefined` in, or a filename that trims to nothing, both come back as
 * `undefined` — the same "no filename supplied" value `commitImport`
 * already treats as `NULL` in `crm_imports.filename`, so callers don't have
 * to special-case an all-whitespace name separately from a missing one.
 */
export function boundFilename(filename: string | undefined): string | undefined {
  const trimmed = filename?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_IMPORT_FILENAME_LENGTH);
}

/**
 * Upper bound on `totalRows` (the caller-reported full file size, including
 * rows the client already dropped as malformed) that `validateTotalRows`
 * will accept — deliberately independent of `MAX_IMPORT_ROWS`, which only
 * bounds the rows actually being written. 20× `MAX_IMPORT_ROWS` is generous
 * headroom for a file that is mostly junk (a batch at the row cap with 19
 * malformed lines for every usable one), while staying nowhere near
 * Postgres's 32-bit `integer` range — the column `crm_imports.row_count`
 * and `.skipped_count` actually are.
 */
export const MAX_TOTAL_ROWS = MAX_IMPORT_ROWS * 20;

/**
 * Validates a caller-supplied `totalRows` before it reaches `commitImport`
 * — Important 2 (review round 2), then Ruling 26 (review round 3): a
 * server-action parameter is untrusted input reaching an `integer NOT
 * NULL` column with no CHECK, the same reasoning `boundFilename` applies
 * to `filename`. Without a check at all, `totalRows: 1e10` fails
 * `commitImport`'s `UPDATE crm_imports` with an integer-overflow error
 * AFTER every row's insert has already run, rolling back an
 * otherwise-fine batch.
 *
 * Rejects rather than clamps. An earlier version of this function silently
 * rewrote an out-of-range value to the nearest valid one — but the
 * rewritten value still fed the audit record (`parseMalformed` is derived
 * from it), so a capability-gated operator could plant a false audit
 * summary just by sending a nonsensical `totalRows`, with no error and no
 * trace that anything was corrected. That is the same failure mode this
 * codebase has already rejected twice — `serialiseSummary` refuses a bad
 * summary key, `validateActionName` refuses a bad action name, both reject
 * over sanitise for exactly this reason: a silently-corrected value
 * produces an audit row nobody can trust. `totalRows` is computed by the
 * client from its own parse (`rows.length + parseImportCsv(...).malformed`
 * in `import-view.tsx`); a value outside what's possible for THIS batch is
 * a bug worth surfacing, not smoothing over.
 *
 * Returns an operator-facing message when `totalRows` is not a finite
 * integer in `[committedRowCount, MAX_TOTAL_ROWS]` — never smaller than
 * the rows actually in the batch (the total can't be smaller than what it
 * describes) and never larger than the cap. Returns `undefined` when the
 * value is valid.
 */
export function validateTotalRows(totalRows: number, committedRowCount: number): string | undefined {
  if (!Number.isInteger(totalRows) || totalRows < committedRowCount || totalRows > MAX_TOTAL_ROWS) {
    return `totalRows (${totalRows}) must be a whole number between ${committedRowCount} and ${MAX_TOTAL_ROWS}.`;
  }
  return undefined;
}

/**
 * Whether any physical line leaves a quoted field open.
 *
 * `parseCsvLine` deliberately does not support a quoted field spanning
 * lines, and `parseImportCsv` splits on newlines BEFORE parsing — so a cell
 * like `"Bondi Baker,\nSydney"` is torn in half, and the continuation
 * fragment (`Sydney"`) is not garbage the parser rejects: it parses cleanly,
 * satisfies `isUsableImportRow` via its `name` column, and becomes a real
 * organisation named after half an address. That is worse than either
 * failure mode this function replaces — worse than refusing the file, and
 * worse than counting the fragment as malformed, because nothing about the
 * result looks wrong until someone reads the CRM.
 *
 * Detected by quote parity rather than by a full multi-line parser: a
 * well-formed line has an even number of `"` (escaped `""` included, being
 * two), and an odd count means a field opened and never closed on that line.
 * Supporting multi-line fields properly is a bigger change to a parser whose
 * documented scope is hand-exported leads sheets; refusing what it cannot
 * read correctly is the honest version of the same scope.
 */
function hasUnbalancedQuotes(lines: readonly string[]): boolean {
  return lines.some((line) => {
    let quotes = 0;
    for (const char of line) {
      if (char === '"') quotes++;
    }
    return quotes % 2 !== 0;
  });
}

export function parseImportCsv(text: string): ParsedImport {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return { rows: [], malformed: 0 };
  }

  if (hasUnbalancedQuotes(lines)) {
    return { rows: [], malformed: 0, rejected: UNBALANCED_QUOTES_MESSAGE };
  }

  const header = parseCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  const rows: ImportRow[] = [];
  let malformed = 0;

  for (const line of lines.slice(1)) {
    const row = cellsToRow(header, parseCsvLine(line));
    if (isUsableImportRow(row)) {
      rows.push(row);
    } else {
      malformed++;
    }
  }

  return { rows, malformed };
}
