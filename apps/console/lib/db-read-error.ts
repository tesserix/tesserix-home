import { NOT_IMPLEMENTED, type SurfaceError } from "@/components/kit/surface-state";
import { isMalformedCursorError } from "./db/keyset-cursor";

/**
 * The one mapping from a rejection caught off `tesserix-postgres` to something
 * an operator may see.
 *
 * WHAT DECIDES WHETHER A SURFACE NEEDS THIS: does the page read the database
 * directly? Not "is it a CRM page". This started life as `crmReadError` in
 * `app/(console)/platform/crm/read-error.ts`, scoped by the feature that
 * happened to need it first, and that framing is exactly why the audit log
 * went on rendering `relation "console_audit_log" does not exist` to an
 * operator months later. The rule is about the data source, so the helper
 * lives beside the other `lib/db` concerns and is named for it.
 *
 * `toSurfaceError` passes `.message` through verbatim — correct for its other
 * callers, which surface errors from `platform-api` whose messages are
 * authored for operators. A database-backed read is not that caller: it
 * catches rejections straight off `pg`, so a relation name, a constraint name
 * or a connection string fragment would render into the page. The CRM WRITE
 * path already treats that as a defect — see `lib/crm-write.ts`, whose module
 * comment records that a hand-rolled copy of it leaked a constraint name the
 * first time an everyday collision happened. This is the same control for
 * every read half.
 *
 * Two things are deliberately preserved rather than flattened:
 *
 * - `status`, when the rejection carries one. `resolveState` reads it to
 *   tell the parked-data-plane case (501) apart from a real failure, and
 *   discarding it here would make a parked surface read as broken.
 * - The real error, logged server-side. An operator-safe message is not a
 *   reason to lose the detail an engineer needs; it is a reason not to put
 *   that detail in front of the wrong reader.
 *
 * `toSurfaceError` itself is left alone on purpose — it has callers outside
 * the database-backed pages whose messages are already safe, and narrowing it
 * for all of them would be a change nobody asked for made in the name of this
 * one.
 */

/**
 * Postgres SQLSTATE for `undefined_table`.
 *
 * Read off `error.code`, which `pg` sets from the wire protocol, rather than
 * matched against the message text: the message is localisable and carries the
 * relation name, and matching on it would both miss a non-English server and
 * couple this control to a string nobody here controls.
 */
export const UNDEFINED_TABLE = "42P01";

/** Callout heading for the un-migrated case. */
export const MIGRATIONS_PENDING_TITLE = "Not set up yet";

/**
 * Copy for a table that does not exist.
 *
 * An un-migrated database is not "something went wrong". Nothing failed and
 * nothing is flaky: the schema was never created here. Telling an operator to
 * try again shortly would be advice that can never work, so this names the
 * remedy — and names it as something a person does, not something they wait
 * for.
 */
export function migrationsPendingMessage(surface: string): string {
  return (
    `Could not load ${surface}: its tables do not exist in tesserix-postgres yet. ` +
    "Run the database migrations against this environment — refreshing will not create them."
  );
}

/**
 * Copy for a `?cursor=` that could not be read.
 *
 * The generic failure copy tells the operator to try again shortly, which is
 * the right advice for a dropped connection and useless here: a truncated,
 * hand-edited or stale cursor fails identically on every load, so "shortly"
 * never arrives. This names the link as the thing that is wrong and points
 * at the surface without it, which is the one action that does work.
 *
 * Only this case changes. Every other read failure keeps `readFailedMessage`,
 * including the ones that look similar from the outside — a rewrite of the
 * generic copy is not what this fixes.
 */
export function invalidCursorMessage(surface: string): string {
  return (
    `Could not load ${surface}: this link's page position is not valid. ` +
    `Retrying will not help — open ${surface} without it to start from the first page.`
  );
}

/**
 * Copy for a read that could not reach Stripe at all, because the mode's
 * restricted read credential is absent or announces the other mode
 * (`StripeReadUnavailableError`, `lib/billing/stripe-read.ts`).
 *
 * The same shape, and the same reason, as `invalidCursorMessage` above: the
 * generic copy says "try again shortly", which is right for a dropped
 * connection and useless here — a credential that is not provisioned fails
 * identically on every load, so "shortly" never arrives. `live` is the plan
 * catalog page's DEFAULT mode and has no restricted read key in this estate
 * today, so this is the ordinary path rather than an exotic one, and an
 * operator reading it needs to know the remedy is provisioning, not patience.
 *
 * Names the credential as the missing thing without naming the variable: the
 * variable is a deployment detail (`stripe-read.ts` owns that message, for a
 * server log), and this string is for a console reader.
 */
export function stripeUnavailableMessage(surface: string): string {
  return (
    `Could not load ${surface}: this mode's Stripe read credential is unavailable, so the check could not run. ` +
    "Retrying will not help — the credential has to be provisioned for this mode before this check can answer."
  );
}

/** Copy for a genuine, possibly transient failure. */
export function readFailedMessage(surface: string): string {
  return `Could not load ${surface}. Try again shortly.`;
}

/**
 * True when a caught value is Postgres reporting that a relation is missing.
 *
 * The `cause` chain is walked one level because a repository may wrap the
 * driver error to add context; the SQLSTATE must survive that wrapping or the
 * page falls back to the generic failure, which is the state this exists to
 * avoid.
 */
export function isUndefinedTable(caught: unknown): boolean {
  for (let value = caught, depth = 0; value !== null && value !== undefined && depth < 4; depth++) {
    if (typeof value !== "object") return false;
    if ((value as { code?: unknown }).code === UNDEFINED_TABLE) return true;
    value = (value as { cause?: unknown }).cause;
  }
  return false;
}

export function dbReadError(caught: unknown, surface: string): SurfaceError | null {
  if (caught === null || caught === undefined) {
    return null;
  }

  const status =
    typeof caught === "object" && typeof (caught as { status?: unknown }).status === "number"
      ? (caught as { status: number }).status
      : undefined;

  // Checked before the log and before every Postgres-shaped classification
  // below, and read the same structural way `toSurfaceError` reads it (never
  // `instanceof`): a caller of this function is not always talking to Postgres
  // any more. `crm-queues.ts` switches its due/drifting reads to the platform
  // API when `PLATFORM_API_ORIGIN` is set, and a `PlatformApiError` from that
  // branch carries `noOperatorToken` rather than a SQLSTATE. Without this check
  // that marker was silently discarded here — `isUndefinedTable` and
  // `isMalformedCursorError` both say no, and the read fell through to the
  // generic "Try again shortly" message, which is exactly the useless-retry
  // copy #300 exists to replace. See `resolveState`, which reads
  // `reauthRequired` ahead of `status` for the same reason.
  //
  // AHEAD OF THE LOG, and that ordering is the point. This condition means "a
  // valid session holds no operator token row" — nothing failed, and
  // tesserix-postgres was never contacted on this path. Logging it at error
  // level would name a database that was not involved, for a non-failure, every
  // time an operator opens a routine surface. The log below is the right home
  // for a GENUINE store failure, which is what reaches it now that
  // `resolvePlatformApiToken` no longer marks those.
  if (typeof caught === "object" && (caught as { noOperatorToken?: unknown }).noOperatorToken === true) {
    return { status, reauthRequired: true };
  }

  // Server-side only: this runs in a React Server Component, so it lands in
  // the app's logs, never in the response.
  console.error(`[console] failed to read ${surface} from tesserix-postgres`, caught);

  if (isUndefinedTable(caught)) {
    // A missing table is the `instrumentation-unavailable` case, not `error`:
    // the calm "this is not wired up yet" state the estate already uses for a
    // parked data plane, carried by the same 501 contract `resolveState`
    // reads. It ships its own copy because the parked-data-plane wording
    // points at an observability doc that has nothing to do with migrations.
    return {
      status: NOT_IMPLEMENTED,
      unavailable: {
        title: MIGRATIONS_PENDING_TITLE,
        message: migrationsPendingMessage(surface),
      },
    };
  }

  if (isMalformedCursorError(caught)) {
    // Checked before the 501 and after the missing-table case, both of which
    // describe the data plane. This one describes the URL: nothing is broken
    // and nothing is parked, so neither of their remedies applies.
    return { status, message: invalidCursorMessage(surface) };
  }

  if (status === NOT_IMPLEMENTED) {
    // Left for `resolveState` to turn into the instrumentation-unavailable
    // state, which has its own copy; a message here would be ignored.
    return { status };
  }

  return { status, message: readFailedMessage(surface) };
}
