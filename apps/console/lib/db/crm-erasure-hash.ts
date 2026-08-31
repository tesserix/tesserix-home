// `server-only`: this module reads the erasure hash key out of the process
// environment. A client component that reaches it must fail the build loudly
// and name the import chain, not ship the key derivation — or the key — into
// a browser bundle.
import "server-only";

import { createHmac } from "node:crypto";
import { normalizeContactEmail, normalizeInstagramHandle } from "./crm-identity";

/**
 * The one-way form of an identifier an erased person can be recognised by
 * without it being retained (#226).
 *
 * # The problem this solves
 *
 * `eraseContact` nulls `email` and `instagram_handle`, and
 * `findMatchingOrganisationId` matches on exactly those two columns. So the
 * next import of the same person matched nothing and `commitImport`
 * re-created them as a new organisation with a fresh opportunity: the erasure
 * silently undone, and no trace on the new row that it had ever happened.
 *
 * Keeping the identifier to compare against is not available — destroying it
 * is what the erasure was. What IS available is a value derived from it that
 * can be compared for equality and cannot be read back.
 *
 * # HMAC, not sha256, and not salt-then-hash
 *
 * A bare `sha256(email)` is not meaningfully one-way for this input. The
 * candidate space is a mailing list; anyone holding a dump of
 * `crm_erased_identifiers` and a scrape could confirm membership by hashing
 * guesses. Keying the digest means a dump alone confirms nothing without also
 * holding `CRM_ERASURE_HASH_KEY`, which lives in the environment and never in
 * the database.
 *
 * The key is fixed and application-wide. That is forced by the requirement,
 * not a corner cut: a per-row random salt cannot be matched against an
 * incoming value, because finding the salt means first finding the row, which
 * is the row you are trying to find. HMAC is the standard primitive for a
 * keyed equality comparison, and naming it as such is also what stops the next
 * person reaching for a homegrown salt scheme.
 *
 * # Namespaced, so two identifier kinds cannot collide
 *
 * The HMAC message is `email:<canonical>` or `ig:<canonical>`, the same
 * namespacing `importRowKeys` uses on the dedup side. Without it a person
 * whose Instagram handle is literally their email address — or any future
 * third identifier — could match on the wrong kind. The prefixes are part of
 * the stored value's meaning: changing one invalidates every hash already
 * recorded under it, exactly as changing the key would.
 *
 * # Normalisation is imported, never reimplemented
 *
 * {@link normalizeContactEmail} and {@link normalizeInstagramHandle} are the
 * same functions `findMatchingOrganisationId` uses. If the hash recorded at
 * erasure and the hash computed for an incoming CSV row disagreed by so much
 * as a trailing space, the check would never match, no row would ever be
 * refused, and NOTHING WOULD FAIL — the import would just re-create the
 * person it exists to refuse. That is a silent no-op wearing the shape of a
 * fix, and it is the failure class this repo has been bitten by more than
 * once (#215, #433). `crm-erasure-hash.test.ts` pins the agreement against
 * the real normaliser rather than a copy.
 *
 * # Absent key: throw here, decide there
 *
 * {@link erasureHashes} throws when the key is unset rather than returning
 * null or an empty list. The two callers want opposite things from an absent
 * key — erasure must fail closed, import must not be taken down by it — and a
 * function that quietly returns "no hashes" would give BOTH of them the
 * fail-open. So the failure is loud here and the policy lives at each call
 * site: `crm-erasure.ts` lets the throw abort the erasure, and `crm-repo.ts`
 * asks {@link isErasureHashKeyConfigured} first and refuses to import at all
 * if hashes exist that it could not check. See those two for the reasoning.
 */

/** The environment variable holding the HMAC key. Named as a constant because
 *  `crm-repo.ts` puts it verbatim into the error an operator reads when an
 *  import is refused for want of it, and a name that drifts between the check
 *  and the message is a name that sends someone to set the wrong variable. */
export const ERASURE_HASH_KEY_ENV = "CRM_ERASURE_HASH_KEY";

/**
 * Raised when {@link erasureHashes} is asked to hash without a key.
 *
 * Its own class, not a bare `Error`: `eraseContact` deliberately lets this
 * escape to fail the erasure, and the action layer above has to be able to
 * tell "this deployment is missing a variable, tell an operator to provision
 * it and retry" apart from "the database rejected the write".
 */
export class ErasureHashKeyMissingError extends Error {
  constructor() {
    super(
      `${ERASURE_HASH_KEY_ENV} is not set; an erasure cannot be recorded in a form ` +
        `the next import can refuse, so it must not be reported as done.`,
    );
    this.name = "ErasureHashKeyMissingError";
  }
}

/**
 * Read at call time, not at import: the console must not fail to boot because
 * a variable has not been provisioned yet, and a module-level read would also
 * make the value un-substitutable from a test that has already imported this.
 */
function readKey(): string | null {
  const raw = process.env[ERASURE_HASH_KEY_ENV];
  if (!raw || raw.length === 0) return null;
  return raw;
}

/**
 * Whether an erasure could be recorded — and therefore whether import's check
 * can mean anything — right now.
 *
 * Exported for `crm-repo.ts`, which needs the answer WITHOUT throwing so it
 * can decide what an import should do about it. Nothing else should branch on
 * this; hashing with no key is a fault, not a mode.
 */
export function isErasureHashKeyConfigured(): boolean {
  return readKey() !== null;
}

/** The two identifier kinds, in the shape both `eraseContact` (reading a
 *  contact row) and the import path (reading a CSV row) already hold. Both
 *  fields optional, and both absent is legal — a contact with neither is a
 *  contact there is nothing to record, not an error. */
export interface ErasureIdentifiers {
  email?: string | null;
  instagramHandle?: string | null;
}

function hash(key: string, namespace: string, canonical: string): string {
  return createHmac("sha256", key).update(`${namespace}:${canonical}`).digest("hex");
}

/**
 * One hash per identifier present, email and handle SEPARATELY.
 *
 * Separately, not combined into a single hash of both, because a person comes
 * back under whichever identifier the next scrape happened to capture. A
 * combined hash would only ever match a row carrying the exact same pair, so
 * the same person arriving with just their email would sail through.
 *
 * Empty array when the input carries neither identifier — the caller (an
 * already-erased contact, whose columns are null; a CSV row with neither
 * field) should not have to special-case that, and there is genuinely nothing
 * to record or check.
 *
 * A present-but-blank value is treated as absent rather than hashed: the
 * canonical form of `"  "` is `""`, and recording a hash of the empty string
 * would refuse every future row whose email cell is blank.
 *
 * @throws {ErasureHashKeyMissingError} when the key is unset. See the module
 * comment: silence here would hand both callers the fail-open.
 */
export function erasureHashes(input: ErasureIdentifiers): string[] {
  const key = readKey();
  if (key === null) throw new ErasureHashKeyMissingError();

  const hashes: string[] = [];
  if (input.email) {
    const canonical = normalizeContactEmail(input.email);
    if (canonical) hashes.push(hash(key, "email", canonical));
  }
  if (input.instagramHandle) {
    const canonical = normalizeInstagramHandle(input.instagramHandle);
    if (canonical) hashes.push(hash(key, "ig", canonical));
  }
  return hashes;
}
