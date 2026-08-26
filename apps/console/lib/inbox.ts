import { PlatformApiError } from "./platform-api";

/**
 * The estate inbox — everything waiting on a human, across every product that
 * implements contract §3.2.
 *
 * §3.2 calls this "the load-bearing one", and §8.5 says why it lives on the
 * platform rail rather than any product's: implementing an inbox does not earn
 * a product a rail entry, it makes that product a source in a surface that
 * already exists. Kora's feedback and unresolved-food items arrive here rather
 * than on a Kora page, which is why `kora.feedback` is `retired` in
 * console-core's routes.ts.
 *
 * This module is the parser only. It refuses a malformed body rather than
 * coercing one, for the same reason `lib/audit.ts` does — see `parseInbox`.
 */

/** One thing a product declares an operator may do to an item. */
export interface InboxAction {
  readonly id: string;
  readonly label: string;
  /** Drives confirmation, and §8.3 additionally requires an idempotency key
   *  when such an action is eventually invoked. Nothing invokes them today. */
  readonly destructive: boolean;
}

export interface InboxItem {
  readonly id: string;
  /** Which product this is waiting in. Required — "something is waiting"
   *  without "where" is not a whole answer, and it is a rendered column. */
  readonly source: string;
  /**
   * The PRODUCT's own vocabulary, rendered verbatim — kora emits `feedback`
   * and `unresolved_food`.
   *
   * Deliberately not narrowed to a union. A console-side enumeration is a
   * second vocabulary that drifts from the first, and an unknown kind rendered
   * as itself is honest where one rendered as "Other" is a small lie. Same
   * reasoning as `EstateTenant.status`.
   */
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string;
  /** ISO 8601 with an offset, per §4.3. Kept as the string the API sent:
   *  parsing to a Date here would throw away the offset the product chose. */
  readonly waitingSince: string;
  /** Present only where the product declared an SLA. Absent and "due now"
   *  must not collapse into each other, hence optional rather than defaulted. */
  readonly dueAt?: string;
  readonly severity?: string;
  /** The product's own deep link, when it offers one. Never rewritten — this
   *  surface does not know how to rewrite another product's URLs, and a
   *  guessed rewrite is worse than an absent link. */
  readonly href?: string;
  readonly actions: readonly InboxAction[];
}

/** One product that could not be read. */
export interface InboxSourceFailure {
  readonly source: string;
  readonly message: string;
}

export interface EstateInbox {
  readonly items: readonly InboxItem[];
  /**
   * The estate's queue DEPTH — the sum of each answering product's own total,
   * which may exceed `items.length` because each product is asked for a
   * bounded page.
   *
   * Counts only products that answered. A failed product contributes nothing
   * rather than zero, so this number is an undercount whenever `failures` is
   * non-empty — which is precisely why the two must be rendered together.
   */
  readonly total: number;
  readonly failures: readonly InboxSourceFailure[];
}

function fail(message: string): never {
  throw new PlatformApiError(`inbox: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function parseAction(value: unknown, path: string): InboxAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: str(row.id, `${path}.id`),
    label: str(row.label, `${path}.label`),
    // Defaulted to false rather than required: a product omitting it is saying
    // "not destructive", and the safe reading of an absent flag is the one
    // that shows a confirmation LESS often only when the product said so.
    destructive: row.destructive === true,
  };
}

function parseItem(value: unknown, path: string): InboxItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  const row = value as Record<string, unknown>;

  // Required, not defaulted, for the same reason `failures` is below: an item
  // whose origin this surface does not know cannot be rendered honestly, and a
  // wrong Source column is worse than a failed read.
  const source = str(row.source, `${path}.source`);

  if (!Array.isArray(row.actions)) fail(`${path}.actions is not an array`);

  return {
    id: str(row.id, `${path}.id`),
    source,
    kind: str(row.kind, `${path}.kind`),
    title: str(row.title, `${path}.title`),
    subtitle: optionalStr(row.subtitle, `${path}.subtitle`),
    waitingSince: str(row.waiting_since, `${path}.waiting_since`),
    dueAt: optionalStr(row.due_at, `${path}.due_at`),
    severity: optionalStr(row.severity, `${path}.severity`),
    href: optionalStr(row.href, `${path}.href`),
    actions: row.actions.map((action, i) => parseAction(action, `${path}.actions[${i}]`)),
  };
}

/**
 * Parse the platform API's `/v1/inbox` payload.
 *
 * **`failures` is required rather than defaulted to `[]`.** That single choice
 * is what makes a partial estate renderable: a body without it is a response
 * this surface cannot prove is complete, and defaulting it would let "one
 * product was unreachable" render identically to "nothing is waiting" — which
 * on a queue is the difference between reassurance and a false one.
 *
 * `total` is required for the same reason: absent, an empty page and a page
 * bounded below a real backlog look the same.
 */
export function parseInbox(json: unknown): EstateInbox {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;

  if (!Array.isArray(body.items)) fail("items is not an array");
  if (!Array.isArray(body.failures)) fail("failures is missing");
  if (typeof body.total !== "number" || !Number.isInteger(body.total) || body.total < 0) {
    fail("total is not a non-negative whole number");
  }

  return {
    items: body.items.map((item, i) => parseItem(item, `items[${i}]`)),
    total: body.total,
    failures: body.failures.map((failure, i) => {
      const path = `failures[${i}]`;
      if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
        fail(`${path} is not an object`);
      }
      const row = failure as Record<string, unknown>;
      return {
        source: str(row.source, `${path}.source`),
        message: str(row.message, `${path}.message`),
      };
    }),
  };
}
