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
}

export interface ParsedImport {
  rows: ImportRow[];
  malformed: number;
}

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
};

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
export function parseImportCsv(text: string): ParsedImport {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return { rows: [], malformed: 0 };
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
