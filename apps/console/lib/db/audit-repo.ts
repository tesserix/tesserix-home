import { CapabilityError } from "@tesserix/platform-auth";

import { isDatabaseConfigured, tesserixQuery } from "./tesserix";

/**
 * The console's operator-action audit trail: its one write, its one read, and
 * the wrapper that makes the write impossible for a caller to forget.
 *
 * The row shape is @tesserix/web's AuditLogEntry, stored column-for-column
 * (see migration 0018), so a row reaches AuditLogViewer without a mapping
 * layer — and so #139's merged audit surface and #158's timeline read the
 * same shape this writes.
 *
 * The rule that makes this module different from every other repository here:
 * **the write does not fail soft.** Everywhere else in this codebase a
 * non-critical write is allowed to degrade — the bell's last-seen write, the
 * notification feed, the search palette all return a state rather than an
 * error. Here degrading means returning results from a lookup that was never
 * recorded, which is precisely what #134's acceptance forbids. A "make this
 * resilient like the others" refactor would be reverting a decision, not
 * hardening one.
 */

/**
 * One row, shaped as AuditLogViewer's `AuditLogEntry`.
 *
 * `timestamp` rather than `occurred_at` because that is the field name the
 * component reads; the column keeps the SQL-safe name and the single SELECT
 * aliases it back. Optional fields are `?`, not `| null`, for the same
 * reason — the component's type says optional.
 */
export interface AuditEntry {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly target?: string;
  readonly timestamp: string;
  readonly metadata?: string;
}

/**
 * What an audited operation is allowed to say about what it returned.
 *
 * Counts, keyed by source. Numbers only, so no row content can travel in a
 * value; keys are checked against an identifier shape below, so no name or
 * email can travel in a key either. That pair is the whole defence: metadata
 * exists to say "two products matched, one did not", never to say who.
 *
 * An audit trail that copies the personal data it exists to account for is a
 * second copy of that data — with a longer retention and a wider read grant
 * than the original.
 */
export type AuditSummary = Readonly<Record<string, number>>;

/**
 * Identifier-shaped keys only: lowercase start, then letters, digits,
 * underscore or dot. Deliberately excludes `@`, spaces, `+` and uppercase, so
 * an email address, a person's name or a raw query cannot be a key even by
 * accident. Length-capped because a key is a source id, not a sentence.
 */
const SUMMARY_KEY = /^[a-z][a-z0-9_.]{0,39}$/;

/**
 * Same shape as `SUMMARY_KEY`, longer cap: an action is a dotted identifier
 * like `crm.stage.change`, not a summary key, so it gets more room for
 * segments, but the same lowercase-identifier constraint applies for the
 * same reason — this is the column a retention or alerting rule
 * discriminates on (migration 0018), not a place for free prose.
 */
const ACTION_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

/** Raised when a summary tries to carry something that is not a count. */
export class AuditSummaryError extends Error {
  constructor(message: string) {
    super(`audit: ${message}`);
    this.name = "AuditSummaryError";
  }
}

/**
 * Raised when an audit `action` is not a stable dotted identifier.
 *
 * Before `describe` (Ruling 15), `action` was a string literal fixed at
 * each call site — statically inspectable, impossible to get wrong at
 * runtime. `describe` makes it a runtime return value like `summary`,
 * which already rejects malformed input rather than sanitising it; leaving
 * `action` unchecked would be the one asymmetry between two fields that
 * arrive together in the same object. A silently truncated or coerced
 * action name is a row nobody can attribute later, which is worse than a
 * loud failure at write time — so this rejects, exactly like
 * `serialiseSummary` does for `summary`.
 */
export class AuditActionError extends Error {
  constructor(message: string) {
    super(`audit: ${message}`);
    this.name = "AuditActionError";
  }
}

/**
 * Validate an action name before it can reach the INSERT.
 *
 * Not sanitisation: an action that fails this is a bug in the caller's
 * `describe` (or a hand-written `writeAuditEntry` call), and silently
 * coercing it into something that looks like a valid action would leave
 * that bug in place while producing a row that reads as fine.
 */
function validateActionName(action: string): void {
  if (!ACTION_NAME.test(action)) {
    throw new AuditActionError(
      `action ${JSON.stringify(action)} is not a stable dotted identifier ` +
        "(e.g. \"crm.stage.change\"); this is the column a retention or " +
        "alerting rule discriminates on, not free prose",
    );
  }
}

/**
 * Raised when the audit row could not be written. Distinct from the
 * operation's own failures on purpose: a caller mapping this to a response
 * must not be able to confuse "the lookup found nothing" with "the lookup was
 * not recorded".
 */
export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super("audit: write failed; the audited operation is not accountable");
    this.name = "AuditWriteError";
    this.cause = cause;
  }
}

/**
 * Raised when there is no database to write the audit row to.
 *
 * "No database, so skip the audit" is not acceptable here. Elsewhere an
 * unconfigured DB is the `instrumentation-unavailable` case — a panel renders
 * a state instead of data, and nothing is lost. For an audit write it would
 * turn a deployment mistake into a silent, permanent bypass of the one
 * control on the operation, with no signal that it happened. A missing
 * variable would be indistinguishable from a working system.
 *
 * So the wrapper checks BEFORE running the operation and refuses to run it at
 * all: nothing is read, so there is nothing that needed accounting for. The
 * route maps this to the same `not_configured` response the other surfaces
 * use — the difference is that here it returns no data with it.
 */
export class AuditUnavailableError extends Error {
  constructor() {
    super("audit: database not configured; refusing to run an unaudited operation");
    this.name = "AuditUnavailableError";
  }
}

/** The facts of a single audited action. */
export interface NewAuditEntry {
  /** The operator's Zitadel `sub`. Opaque string, not a uuid. */
  readonly actor: string;
  /** Stable dotted identifier, e.g. `identity.lookup`. Not prose. */
  readonly action: string;
  /** What was acted on — for a lookup, the query as entered. */
  readonly target?: string;
  /** Counts only. Serialised, validated, and never the returned rows. */
  readonly summary?: AuditSummary;
  /** The instant of the operation. Defaults to now at write time. */
  readonly occurredAt?: string;
}

/**
 * pg parses timestamptz into a Date; every consumer (the viewer, JSON
 * responses, lexicographic sort) wants ISO-8601. Normalise once, here, rather
 * than making each caller guess — same contract as notifications-repo.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("audit: expected a timestamp");
}

/**
 * SQL NULL for an absent optional; the row types say `?`, not `| null`.
 * Anything else is malformed and is left to fail loudly rather than being
 * coerced into a plausible-looking string.
 */
function toOptional(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error("audit: expected a nullable text column");
}

/**
 * Validate and serialise a summary.
 *
 * Rejects rather than sanitises: a summary that tried to carry a row is a bug
 * in the caller's summariser, and quietly dropping the offending key would
 * leave that bug in place while producing an audit row that looks fine.
 *
 * Keys sorted so the same summary always serialises identically — two rows
 * that recorded the same outcome should compare equal as text.
 */
export function serialiseSummary(summary: AuditSummary): string {
  const entries = Object.entries(summary);
  for (const [key, value] of entries) {
    if (!SUMMARY_KEY.test(key)) {
      throw new AuditSummaryError(
        `summary key ${JSON.stringify(key)} is not an identifier; ` +
          "metadata carries counts per source, never result content",
      );
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new AuditSummaryError(
        `summary value for ${JSON.stringify(key)} must be a non-negative integer count`,
      );
    }
  }
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(sorted));
}

/**
 * Write one audit row.
 *
 * Exported because not every auditable event is an operation that returns
 * data to a caller. On its own it protects nothing — a caller can still
 * forget to call it, which is why anything that returns data to an operator
 * goes through `auditedOperation` instead. Validated here rather than only
 * in `auditedOperation`, so this — the bare-write path — carries the same
 * guarantee: nothing reaches `console_audit_log` with an action that isn't
 * a stable dotted identifier, regardless of which of the two entry points
 * produced it.
 *
 * Failures are wrapped, never swallowed.
 */
export async function writeAuditEntry(entry: NewAuditEntry): Promise<void> {
  // Validated before the summary and outside the try, same as
  // `serialiseSummary` below: a malformed action is a bug in the caller, not
  // a database failure, and must surface as its own error rather than being
  // reported as one.
  validateActionName(entry.action);
  const metadata =
    entry.summary === undefined ? null : serialiseSummary(entry.summary);
  const occurredAt = entry.occurredAt ?? new Date().toISOString();
  try {
    await tesserixQuery(
      `INSERT INTO console_audit_log (actor, action, target, occurred_at, metadata)
       VALUES ($1, $2, $3, $4::timestamptz, $5)`,
      [entry.actor, entry.action, entry.target ?? null, occurredAt, metadata],
    );
  } catch (cause) {
    throw new AuditWriteError(cause);
  }
}

/**
 * Recent activity, newest first. Served by console_audit_recent_idx.
 *
 * Minimal on purpose: the surface that will render this does not exist yet
 * (#139, #158), and filtering built against a guess at what it needs is
 * filtering that has to be un-built. A limit and an order is all a reader can
 * currently justify.
 */
export async function recentAuditEntries(limit: number): Promise<AuditEntry[]> {
  const rows = await tesserixQuery<{
    id: string;
    actor: string;
    action: string;
    target: string | null;
    timestamp: unknown;
    metadata: string | null;
  }>(
    // occurred_at aliased to the field name AuditLogViewer reads. The column
    // is not called `timestamp` because that is a type name in SQL; the alias
    // is one word here instead of a mapper in every consumer.
    `SELECT id::text, actor, action, target,
            occurred_at AS "timestamp", metadata
       FROM console_audit_log
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: toOptional(row.target),
    timestamp: toIso(row.timestamp),
    metadata: toOptional(row.metadata),
  }));
}

/** What an operation's audit row should say, computed from its own result.
 *
 * `target` is optional and, when present, overrides `AuditedOperation.target`
 * (Ruling 20). Most callers know their target before the operation runs (an
 * opportunity id, say) and pass it as `AuditedOperation.target` directly. But
 * some don't: `removeSuppression` is looked up and deleted by an opaque
 * uuid, while the identifier an auditor actually wants to see — the email or
 * Instagram handle #204 already calls the accountable fact — is only known
 * from the operation's *result*, exactly like `action`/`summary` above. This
 * is the same reason those two live in `describe` rather than at the call
 * site: a single call cannot always know upfront what it will turn out to be
 * accounting for. */
export interface AuditDescription {
  readonly action: string;
  readonly summary: AuditSummary;
  readonly target?: string;
}

/**
 * Opt-in for an error that represents a DELIBERATE refusal — policy said no
 * — rather than a failure. The decision to audit lives with the error
 * itself rather than being duplicated at every call site that can throw one:
 * a caller writes `throw new PublishRefused(...)` once, and every path that
 * goes through `auditedOperation` picks it up without having to know it
 * exists.
 *
 * Deliberately not satisfied by every `Error`: a plain `Error` is a failure
 * (a bug, a dropped connection), not a decision, and must NOT gain this
 * shape by accident. See `refusalDescription` and #409.
 */
export interface AuditableRefusal {
  /** What the audit row should say about this refusal. */
  readonly auditRefusal: () => AuditDescription;
}

/**
 * Structural check, not `instanceof`: `AuditableRefusal` is a console-local
 * interface, and an error class defined anywhere (including another
 * package) can implement it without importing this module.
 */
export function isAuditableRefusal(
  value: unknown,
): value is Error & AuditableRefusal {
  return (
    value instanceof Error &&
    "auditRefusal" in value &&
    typeof (value as { auditRefusal?: unknown }).auditRefusal === "function"
  );
}

/**
 * Recognise a refusal among the causes `auditedOperation` might catch.
 *
 * Two branches, both explicit, neither guessing from a string:
 *
 * - `AuditableRefusal` — the general case. An error declares its own audit
 *   description (`PublishRefused`, and any future refusal type).
 * - `CapabilityError` — lives in `@tesserix/platform-auth`, which this
 *   console package depends on; the dependency cannot run the other way, so
 *   `CapabilityError` cannot implement a console-local interface. It gets
 *   its own branch here instead of being duck-typed on `err.name`, which
 *   would silently match anything (including a bug) that happened to reuse
 *   that string.
 *
 * Returns `null` for anything else — a failure, not a decision — so the
 * caller in `auditedOperation` writes nothing and rethrows unchanged.
 */
function refusalDescription(cause: unknown): AuditDescription | null {
  if (isAuditableRefusal(cause)) {
    return cause.auditRefusal();
  }
  if (cause instanceof CapabilityError) {
    // `required` is a hyphenated capability name (e.g. "publish-catalog"),
    // which SUMMARY_KEY's identifier shape rejects — hyphens aren't
    // permitted. Underscored rather than dropped, so the row still names
    // which capability was missing instead of only that one was.
    const capability = cause.required.replaceAll("-", "_");
    return {
      action: "capability.refused",
      summary: { [capability]: 1 },
      // No target override: the operation never ran, so the caller's
      // upfront `spec.target` (what was being acted on) is still the more
      // accountable fact than the capability name, which already lives in
      // `summary`.
    };
  }
  return null;
}

/** An audited operation and the facts that account for it. */
export interface AuditedOperation<T> {
  readonly actor: string;
  /** Used verbatim unless `describe`'s result overrides it — see
   *  `AuditDescription.target`. */
  readonly target?: string;
  /** The work being accounted for. Runs only if the audit can be written. */
  readonly operation: () => Promise<T>;
  /**
   * Reduces the result to what the audit row should say: which action
   * happened, and counts. Takes the *result*, not a value fixed at the call
   * site, because a single call site can cover more than one real action —
   * a write that turned out to be a no-op is not the same action as one that
   * changed something, and neither is a write that changed a different field
   * than the one the call site was named for. `action` living here, next to
   * `summary`, is what lets a caller report that honestly with one write
   * instead of picking an action name before it knows what happened.
   *
   * Its `summary` return type is also the reason a caller cannot hand result
   * rows to the audit trail: there is nowhere in `AuditSummary` for a row to
   * go.
   */
  readonly describe: (result: T) => AuditDescription;
}

/**
 * Run an operation and record it — or run neither.
 *
 * **On the shape of this API.** A bare `writeAuditEntry()` that every call
 * site must remember to invoke puts the guarantee in the caller's discipline:
 * it is correct on the day it is written and one refactor away from an
 * unaudited early return, and nothing in the type system notices. Wrapping
 * the operation moves the guarantee into the only path that produces a
 * result. A caller cannot obtain the lookup's rows without having gone
 * through the write, because the rows are returned by this function and by
 * nothing else. That is the difference between a convention and a control,
 * and this is the one place in this codebase that needs a control.
 *
 * Ordering, and what each step guarantees:
 *
 * 1. No database → refuse before the operation runs. Nothing is read, so
 *    nothing went unaccounted for. See AuditUnavailableError.
 * 2. Run the operation.
 *    - It throws a DELIBERATE REFUSAL (`refusalDescription` recognises it)
 *      → write a row describing the refusal, then rethrow the original
 *      `cause` unchanged. A refusal is a decision, and belongs in the log:
 *      the highest-stakes action in this system is exactly the one most
 *      worth recording when it is refused, not only when it succeeds.
 *    - It throws anything else (a FAILURE — not a decision: a bug, a
 *      dropped connection, `AuditWriteError`) → propagate unchanged,
 *      writing nothing. Recording it would put a database write exactly on
 *      the path where the database is the likely cause, and would bury the
 *      refusals worth reading — the rows this exists for — in operational
 *      noise. See #409.
 * 3. Describe, then write. **The row is written even when the operation
 *    returned nothing**: "who searched for whom and found nothing" is the
 *    interesting case, and a zero-result summary is still a summary.
 * 4. The write throws → the result is discarded and AuditWriteError
 *    propagates. The caller never sees rows that were not recorded. This is
 *    the deliberate non-resilience; see the module comment before changing it.
 */
export async function auditedOperation<T>(spec: AuditedOperation<T>): Promise<T> {
  if (!isDatabaseConfigured()) {
    throw new AuditUnavailableError();
  }

  let result: T;
  try {
    result = await spec.operation();
  } catch (cause) {
    const refusal = refusalDescription(cause);
    if (refusal) {
      await writeRefusal(spec, refusal);
    }
    // Rethrow the ORIGINAL cause either way, refusal or failure: auditing
    // changes what is recorded, never what the caller sees.
    throw cause;
  }

  // Described before the write and outside its try, so a bug in `describe`
  // surfaces as AuditSummaryError rather than being reported as a database
  // failure — and so the result is still discarded either way.
  const { action, summary, target } = spec.describe(result);

  await writeAuditEntry({
    actor: spec.actor,
    action,
    // Ruling 20: `describe`'s target, when it supplies one, overrides the
    // upfront `spec.target` — the result is the only place some callers
    // (`removeSuppression`) ever learn the identifier worth recording.
    // Falls back on an empty string too, not only `undefined`/`null`: a
    // `describe` that computed `""` (e.g. a removal whose row had neither
    // an email nor a handle, which the CHECK constraint should prevent but
    // this function has no way to verify) has nothing worth recording
    // either, and writing an empty target would be strictly less useful
    // than the upfront fallback it was supposed to improve on.
    target: target || spec.target,
    summary,
  });

  return result;
}

/**
 * Write the row for a recognised refusal, on a best-effort basis.
 *
 * THE SUBTLE CASE (#409): what if the refusal's own audit write fails? The
 * caller needs to know they were refused — that is the operation's real
 * outcome, and a truthful one. Letting `AuditWriteError` propagate instead
 * would tell them "audit failed" when what actually happened is "you were
 * refused", which is both a worse answer and a wrong one: `AuditWriteError`
 * is documented above as meaning the operation's *own* results are
 * unaccounted for, and a refusal has none to lose.
 *
 * So this failure is swallowed here, after being logged server-side, and
 * the caller in `auditedOperation` always rethrows the original refusal
 * regardless of whether this write succeeded. The row that should have
 * existed but doesn't is a real gap — exactly the class of gap #409 exists
 * to close — but it is a gap to notice in server logs and alerting, not one
 * to paper over with a false success or hide by reporting the wrong error
 * to the caller.
 */
async function writeRefusal<T>(
  spec: AuditedOperation<T>,
  refusal: AuditDescription,
): Promise<void> {
  try {
    await writeAuditEntry({
      actor: spec.actor,
      action: refusal.action,
      target: refusal.target || spec.target,
      summary: refusal.summary,
    });
  } catch (writeFailure) {
    // Server-side signal only; see the doc comment above on why this is
    // swallowed rather than propagated.
    console.error(
      "audit: failed to record a refused operation; the refusal itself " +
        "still reached the caller",
      writeFailure,
    );
  }
}
