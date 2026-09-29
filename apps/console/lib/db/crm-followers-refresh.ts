import { normalizeInstagramHandle } from "./crm-identity";
import { setFollowersCount } from "./crm-writes";
import { tesserixQuery } from "./tesserix";

/**
 * Re-scrape reconciliation: take a batch of `handle -> followers` readings and
 * write them onto the contacts they belong to.
 *
 * # Why the input is readings rather than a scraper
 *
 * This module does not talk to Instagram. Fetching profiles is rate-limited,
 * account-risky and changes shape whenever Instagram feels like it; reconciling
 * numbers against contacts is none of those things. Keeping them apart means a
 * scrape can be run by hand, by a browser session, or by a future job without
 * any of them having to agree about database access — and it means THIS can be
 * tested without a network.
 *
 * # Matching is by handle, normalised at both ends
 *
 * `normalizeInstagramHandle` — trim, strip leading `@`, lowercase — is applied
 * to the incoming reading, and the lookup compares against `lower(...)` of the
 * stored column, which migration 0023's trigger already keeps canonical. A
 * reading typed as `@Krafty.Knots` therefore finds the contact stored as
 * `krafty.knots`. Anything else would make the caller responsible for a
 * normalisation the database already has an opinion about.
 *
 * # An unmatched reading is REPORTED, never created
 *
 * A handle with no contact behind it means the lead was voided, erased, or was
 * never in the CRM — all three are facts about the target list, not an
 * invitation to insert a row. Creating contacts from scrape output is
 * `commitImport`'s job, where the lawful basis and provenance are supplied and
 * the suppression list is consulted. A refresh silently acquiring people would
 * route around every one of those checks.
 *
 * # Erased contacts are excluded
 *
 * `eraseContact` nulls `followers_count` deliberately. Writing a fresh number
 * back would reverse an erasure with a metrics job, so the lookup filters them
 * out and they surface as unmatched.
 */
export interface FollowerReading {
  /** As scraped. Normalised here; `@` and casing do not matter. */
  handle: string;
  followersCount: number;
}

export interface RefreshFollowersOptions {
  readings: readonly FollowerReading[];
  actor: string;
  /** Report what would change and write nothing. */
  dryRun: boolean;
}

export interface RefreshFollowersFailure {
  handle: string;
  message: string;
}

export interface RefreshFollowersResult {
  /** Readings that resolved to a live contact. */
  matched: number;
  /** Of those, how many actually moved. Zero on a dry run, by construction. */
  changed: number;
  /** Readings with no live contact behind them — voided, erased, or never
   *  imported. Reported so a shrinking target list is visible rather than
   *  silently absorbed. */
  unmatched: string[];
  failures: RefreshFollowersFailure[];
}

interface ContactRow {
  id: string;
  instagram_handle: string;
}

export async function refreshFollowerCounts(
  options: RefreshFollowersOptions,
): Promise<RefreshFollowersResult> {
  const { readings, actor, dryRun } = options;

  // De-duplicated, last reading wins: a scrape that visited a profile twice
  // should not produce two timeline entries for one number.
  const byHandle = new Map<string, number>();
  for (const reading of readings) {
    const handle = normalizeInstagramHandle(reading.handle);
    if (handle.length > 0) byHandle.set(handle, reading.followersCount);
  }

  const result: RefreshFollowersResult = {
    matched: 0,
    changed: 0,
    unmatched: [],
    failures: [],
  };
  if (byHandle.size === 0) return result;

  const handles = [...byHandle.keys()];
  const rows = await tesserixQuery<ContactRow>(
    `SELECT id, instagram_handle
       FROM crm_contacts
      WHERE lower(instagram_handle) = ANY($1)
        AND erased_at IS NULL`,
    [handles],
  );

  const contactByHandle = new Map<string, string>();
  for (const row of rows) {
    contactByHandle.set(normalizeInstagramHandle(row.instagram_handle), row.id);
  }

  for (const handle of handles) {
    const contactId = contactByHandle.get(handle);
    if (contactId === undefined) {
      result.unmatched.push(handle);
      continue;
    }
    result.matched += 1;
    if (dryRun) continue;

    try {
      const { changed } = await setFollowersCount({
        contactId,
        followersCount: byHandle.get(handle) as number,
        actor,
      });
      if (changed.length > 0) result.changed += 1;
    } catch (cause) {
      // The run continues: one bad reading must not strand the rest of a
      // target list, and the failure is reported so the count cannot be read
      // as a clean sweep.
      result.failures.push({
        handle,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return result;
}

/**
 * Parse `handle,followers` lines into readings.
 *
 * Deliberately strict about the number and lax about the handle: a handle is
 * normalised downstream anyway, but a follower count that silently became
 * `NaN` would be refused one layer later by `assertRefreshableFollowersCount`
 * with the contact id rather than the line, and the operator would have no way
 * back to the row they mistyped.
 *
 * Blank lines and `#` comments are skipped so a hand-maintained target list can
 * carry notes.
 */
export function parseFollowerReadings(text: string): FollowerReading[] {
  const readings: FollowerReading[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    // Split on the FIRST comma only, and strip the separators from what is
    // left. Instagram renders counts as "4,054", and a naive split on every
    // comma reads that line as 4 — a silent 1000x error on exactly the
    // copy-paste this parser exists to accept.
    const comma = line.indexOf(",");
    if (comma === -1) {
      throw new Error(`line ${index + 1}: expected "handle,followers", got "${line}"`);
    }
    const handle = line.slice(0, comma).trim();
    const countCell = line.slice(comma + 1).trim();
    if (handle.length === 0 || countCell.length === 0) {
      throw new Error(`line ${index + 1}: expected "handle,followers", got "${line}"`);
    }
    // `Number` rather than `parseInt`: "12abc" must be a refusal, not 12.
    const followersCount = Number(countCell.replace(/,/g, ""));
    if (!Number.isInteger(followersCount) || followersCount < 0) {
      throw new Error(
        `line ${index + 1}: "${countCell}" is not a non-negative integer follower count`,
      );
    }
    readings.push({ handle, followersCount });
  }
  return readings;
}
