import "server-only";

import { writeAuditEntry } from "./audit-repo";

/**
 * Record a refusal (#265, RBAC R5).
 *
 * # Why not `auditedOperation`
 *
 * R5.2. `auditedOperation` is built around DESCRIBING A RESULT — it runs the
 * operation, then asks the caller to name what happened. A refusal has no
 * result, and bending it to fit would mean inventing a fake one to describe.
 * This is the sibling writer that issue asks for, sharing the same table.
 *
 * # Why the same table
 *
 * `console_audit_log`, not a table of its own. The acceptance asks that
 * denials be "visible somewhere an operator can read them", and the audit
 * surface already reads this table — a separate one would need a second
 * surface built before anybody could see a single row. The noise argument
 * against sharing is real and is answered by the collapsing below rather than
 * by a second table.
 *
 * # Why this must never throw
 *
 * R5.3, and it is the inverse of `auditedOperation`'s rule. That one fails
 * CLOSED — an operation that cannot be audited does not proceed — because an
 * unaudited mutation is worse than a refused one. The reasoning does not carry
 * over: refusing to refuse because the log is unavailable would turn a logging
 * outage into an ACCESS-CONTROL outage, and the request being recorded here is
 * already being denied. So every failure is swallowed after a warn, and the
 * caller's refusal proceeds untouched.
 */

/** How long the same refusal is collapsed into one row. */
const COLLAPSE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The last time each (actor, capability, target) was recorded.
 *
 * In process, deliberately. A tight loop against a restricted URL must not be
 * able to fill the audit table — the acceptance asks for a volume bound — and
 * a bound that itself writes to the database to decide whether to write to the
 * database defeats its own purpose.
 *
 * The cost of in-process is that a pod restart forgets, and that two replicas
 * each keep their own map. Both are acceptable HERE and would not be for a
 * security counter: the worst case is a handful of extra rows describing a
 * refusal that genuinely happened. Nothing is under-reported — the first
 * refusal of any distinct shape is always written — and that is the direction
 * that matters for a log nobody reads until they need it.
 */
const lastRecorded = new Map<string, number>();

/**
 * Bounded so a probing script cannot grow the map without limit — the same
 * attack the collapsing exists to blunt, one level up. On overflow the whole
 * map is dropped rather than evicted one by one: an LRU here would be precision
 * nobody needs, and the consequence of dropping it is one extra row per key.
 */
const MAX_TRACKED_KEYS = 10_000;

export interface DeniedAttempt {
  /** The operator's subject or email — whatever the caller has. */
  readonly actor: string;
  /** The capability that was required and not held. */
  readonly required: string;
  /** What was being reached: a path for a surface, an id for a verb. */
  readonly target: string;
  /**
   * `surface` for a route refusal (#262's gate), `verb` for a mutation
   * refused by a capability check. Kept apart because they answer different
   * questions: a burst of surface refusals is someone probing the estate,
   * a verb refusal is an operator meeting the edge of their own grant.
   */
  readonly kind: "surface" | "verb";
}

/** True when this exact refusal has not been recorded inside the window. */
function shouldRecord(key: string, now: number): boolean {
  const previous = lastRecorded.get(key);
  if (previous !== undefined && now - previous < COLLAPSE_WINDOW_MS) return false;
  if (lastRecorded.size >= MAX_TRACKED_KEYS) lastRecorded.clear();
  lastRecorded.set(key, now);
  return true;
}

/** Exported for tests: the collapsing is time-based, and a test that had to
 *  wait five minutes to prove it would not be written. */
export function resetDeniedAttemptCollapsing(): void {
  lastRecorded.clear();
}

export async function recordDeniedAttempt(attempt: DeniedAttempt): Promise<void> {
  const key = `${attempt.kind}:${attempt.actor}:${attempt.required}:${attempt.target}`;
  if (!shouldRecord(key, Date.now())) return;

  try {
    await writeAuditEntry({
      actor: attempt.actor,
      // A dotted identifier like every other action, and distinct per kind so
      // the timeline can be read for one without the other.
      action: `capability.refused.${attempt.kind}`,
      target: attempt.target,
      // `AuditSummary` is counts only, so the capability is a KEY rather than
      // a value — with hyphens underscored, because SUMMARY_KEY's identifier
      // shape rejects them. Exactly what `refusalDescription` does for the
      // refusals `auditedOperation` already writes, so a reader meets one
      // shape across both paths rather than two.
      summary: { [attempt.required.replaceAll("-", "_")]: 1 },
    });
  } catch (cause) {
    // Swallowed on purpose — see the module doc. Warned rather than silent,
    // because "denials stopped being recorded" is itself worth noticing, and a
    // log that fails invisibly is the failure this whole issue is about.
    console.warn("[audit] could not record a denied attempt", {
      kind: attempt.kind,
      required: attempt.required,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
