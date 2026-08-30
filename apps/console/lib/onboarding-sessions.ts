// `PlatformApiError` from HERE, not from `./platform-api`: this module is
// imported (as a type) by a client component, and the class is a VALUE, so
// importing it from `platform-api.ts` would rope `pg` into the browser bundle.
// See `platform-api-error.ts`'s own header.
import { PlatformApiError } from "./platform-api-error";

/**
 * One product's onboarding sessions — the rows behind the funnel's counts,
 * from `GET /v1/onboarding/sessions?source=…`.
 *
 * # These rows are PII, deliberately and with approval
 *
 * Every row is a merchant's email address. platform-api keeps PII out of every
 * failure path — no email reaches a log line, an error message, or a truncated
 * body — and this module holds the same line: the failures below name a FIELD
 * PATH and never a value, so no message this file can produce carries an
 * address. `onboarding-sessions.test.ts` asserts it.
 *
 * # An empty list is an answer; an unreadable one is not
 *
 * The rule the funnel states ("a stage with zero is a measurement; a funnel
 * that could not be read is not") inverts here and is enforced the same way.
 * `[]` is a real, valid result — nobody matched the filter — and passes
 * through untouched. Anything that is not an array THROWS rather than
 * degrading to `[]`, because `data ?? []` and `data.map(…)` on a null both
 * render an empty queue, and an operator shown "no sessions" believes it.
 * platform-api already refuses those shapes with a 503 for exactly this
 * reason; this parser is the same guard on the console's side of the wire, so
 * neither end is the only thing standing between the two answers.
 *
 * # The fields are mark8ly's wire row, not its Go type
 *
 * Read off `sessionRow` in mark8ly's `platformadmin/onboarding.go`, which is
 * projected field by field from `onboardingfunnel.Session` precisely so the
 * upstream's `draft` blob of merchant-entered wizard data cannot reach a
 * console. The internal type also carries `email_verified_at`; the wire row
 * does NOT, so neither does this. A shape written from the Go type would
 * invent a field that never arrives.
 */
export interface OnboardingSession {
  readonly id: string;
  /** The merchant's address. The reason this surface is its own route. */
  readonly email: string;
  /**
   * mark8ly's own word, rendered verbatim.
   *
   * There is no console-side enum to check it against, and deliberately so:
   * the vocabulary belongs to mark8ly's upstream onboarding service, which
   * this deployment cannot see or version. platform-api forwards `status`
   * unvalidated for the same reason — a mistyped one comes back as a visibly
   * empty list, which is the truthful answer to what was asked.
   */
  readonly status: string;
  /** RFC 3339, as the product formatted it. */
  readonly createdAt: string;
  readonly lastActivityAt: string;
  /** Hours since `lastActivityAt`, as the product measured it. Fractional. */
  readonly idleHours: number;
  /** The product's own judgement, not one derived here from `idleHours`. */
  readonly abandoned: boolean;
  /** `null` until the session completes — the contract pins it as an explicit
   *  null rather than an omitted key. */
  readonly completedAt: string | null;
  /** The tenant this session became, `null` while it is still a session. The
   *  one field that answers "did this signup convert". */
  readonly tenantId: string | null;
}

export interface OnboardingSessionList {
  readonly rows: readonly OnboardingSession[];
  /**
   * Every session matching the filter, ignoring the page limit. Required: a
   * page with no total reads as the whole list, which is how an operator
   * working a queue stops early believing they are done.
   */
  readonly total: number;
  /**
   * The page size mark8ly APPLIED, which is not always the one asked for —
   * platform-api clamps to 200 and the product may narrow further.
   *
   * `null` when the API reported none. `meta.limit` is `omitempty` on the
   * wire, so an absent key means zero, and zero is not a page size any caller
   * can do arithmetic with. Kept as `null` rather than defaulted here so the
   * decision about what to do without it belongs to the surface that renders
   * a range, where it can be made in one place and commented.
   */
  readonly limit: number | null;
}

/**
 * Every failure names a PATH and never a value. `data[3].email is not a
 * string` says everything a reader needs; `data[3].email is 42` would put a
 * merchant's address in a message the moment the shape is right and the
 * content is not.
 */
function fail(message: string): never {
  throw new PlatformApiError(`onboarding sessions: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

/** `null` and a real value are both legitimate; anything else is not. An
 *  ABSENT key is refused too — the contract pins these as explicit nulls, so a
 *  missing one means something other than mark8ly's handler answered. */
function nullableStr(row: Record<string, unknown>, key: string, path: string): string | null {
  if (!(key in row)) fail(`${path} is absent — the contract pins it as an explicit null`);
  const value = row[key];
  if (value === null) return null;
  return str(value, path);
}

function parseRow(value: unknown, path: string): OnboardingSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  const idleHours = row.idle_hours;
  if (typeof idleHours !== "number" || !Number.isFinite(idleHours) || idleHours < 0) {
    fail(`${path}.idle_hours is not a non-negative number`);
  }
  if (typeof row.abandoned !== "boolean") fail(`${path}.abandoned is not a boolean`);
  return {
    id: str(row.id, `${path}.id`),
    email: str(row.email, `${path}.email`),
    status: str(row.status, `${path}.status`),
    createdAt: str(row.created_at, `${path}.created_at`),
    lastActivityAt: str(row.last_activity_at, `${path}.last_activity_at`),
    idleHours,
    abandoned: row.abandoned,
    completedAt: nullableStr(row, "completed_at", `${path}.completed_at`),
    tenantId: nullableStr(row, "tenant_id", `${path}.tenant_id`),
  };
}

/**
 * Parse the envelope's `data` and `meta` into one page.
 *
 * The two arrive separately because the rows live in `data` and the pagination
 * lives in `meta` — see `platformRequestWithMeta`, which is the only call that
 * keeps the second.
 */
export function parseOnboardingSessions(data: unknown, meta: unknown): OnboardingSessionList {
  // The load-bearing line. Absent, null, a string, an object: each of those
  // renders as an empty queue one layer down, and none of them is one.
  if (!Array.isArray(data)) fail("data is not a list — an unreadable list is not an empty one");

  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    fail("meta is missing — a page with no total reads as the whole list");
  }
  const envelope = meta as Record<string, unknown>;
  const total = envelope.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    fail("meta.total is not a non-negative whole number");
  }
  const limit = envelope.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)) {
    fail("meta.limit is not a whole number");
  }

  return {
    rows: data.map((row, i) => parseRow(row, `data[${i}]`)),
    total,
    // Zero and absent are the same non-answer: `omitempty` erases a zero on
    // the wire, so there is no page size here either way.
    limit: typeof limit === "number" && limit > 0 ? limit : null,
  };
}
