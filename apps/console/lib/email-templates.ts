/**
 * mark8ly's transactional email registry, as the console reads it (#588, epic
 * #586).
 *
 * The wire contract is platform-api's `emailtemplates` module, verified
 * against its committed goldens in
 * `platform-api/internal/modules/emailtemplates/internal/handler/testdata/`.
 * This module owns the types, the parsers and — the part that carries the
 * feature — the vocabulary the UI renders `state` and `sends_from` in.
 *
 * # NO IMPORTS, DELIBERATELY
 *
 * Both the list view and the editor are `"use client"`, and the error narrowing
 * below reads a caught value STRUCTURALLY rather than with
 * `instanceof PlatformApiError`. That keeps this module free of every `lib/`
 * import, so nothing here can become the rope that drags `lib/platform-api.ts`
 * -> `auth/platform-token.ts` -> `db/tesserix.ts` -> `pg` into the browser
 * bundle. `lib/platform-api-error.ts`'s header records the incident; the
 * cheapest way not to repeat it is to import nothing at all.
 */

/** `published`, `draft` or `unauthored`. See `EMAIL_TEMPLATE_STATES`. */
export type EmailTemplateState = "published" | "draft" | "unauthored";

/** `row`, `embedded` or `nothing` — where a send takes its copy from NOW. */
export type SendsFrom = "row" | "embedded" | "nothing";

const STATES: readonly string[] = ["published", "draft", "unauthored"];
const SENDS_FROM: readonly string[] = ["row", "embedded", "nothing"];

/** One declared interpolation, in the product's own vocabulary for `type`. */
export interface EmailTemplateVariable {
  name: string;
  type: string;
  required: boolean;
}

/** One row of the registry listing. */
export interface EmailTemplateRow {
  /** `<source>:<key>`. Every write is keyed on this, never on `key` alone. */
  id: string;
  source: string;
  key: string;
  state: EmailTemplateState;
  sends_from: SendsFrom;
  has_embedded_default: boolean;
  /** RAW template source, not an interpolated line — it carries no customer data. */
  subject: string;
  /** Absent for an unauthored key rather than zeroed. */
  version?: number;
  updated_at?: string;
  updated_by?: string;
}

/** A row plus the bodies and the declared variables. */
export interface EmailTemplateDetail extends EmailTemplateRow {
  html_body: string;
  text_body: string;
  variables: EmailTemplateVariable[];
}

/** One source that could not be read. */
export interface EmailTemplateFailure {
  source: string;
  message: string;
}

/**
 * The listing.
 *
 * `failures` is the ONLY thing separating a failed read from an empty
 * registry: a source that answered 500 contributes no rows, so `templates: []`
 * with a non-empty `failures` renders as "no templates" unless something
 * reads this field. See `list-source-failed.json`.
 */
export interface EmailTemplatesPage {
  templates: EmailTemplateRow[];
  failures: EmailTemplateFailure[];
}

/**
 * One sentence naming every source that could not be read.
 *
 * The `message` is a coarse, closed-set string minted by platform-api
 * (`responded 500`, and the like) rather than free text from the product — the
 * unredacted cause goes to platform-api's log and never onto the wire — so it
 * is safe to render verbatim.
 *
 * It lives here rather than beside the page that first needed it because both
 * the page (deciding the surface state) and the client view (labelling a
 * partial listing) say it, and the view must not import from a server module.
 */
export function failureSentence(failures: readonly EmailTemplateFailure[]): string {
  return failures
    .map((failure) => `${failure.source} could not be read (${failure.message}).`)
    .join(" ");
}

class ShapeError extends Error {}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(`email templates: ${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ShapeError(`email templates: ${path} is not a string`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], path: string): T {
  const text = str(value, path);
  if (!allowed.includes(text)) {
    // Refused rather than defaulted. Defaulting an unrecognised `sends_from`
    // to anything at all would state, in a column an operator trusts, which
    // copy is going to customers — on the strength of a guess.
    throw new ShapeError(`email templates: ${path} is not one of ${allowed.join(", ")}`);
  }
  return text as T;
}

function parseRow(value: unknown, path: string): EmailTemplateRow {
  const raw = obj(value, path);
  const row: EmailTemplateRow = {
    id: str(raw.id, `${path}.id`),
    source: str(raw.source, `${path}.source`),
    key: str(raw.key, `${path}.key`),
    state: oneOf<EmailTemplateState>(raw.state, STATES, `${path}.state`),
    sends_from: oneOf<SendsFrom>(raw.sends_from, SENDS_FROM, `${path}.sends_from`),
    has_embedded_default: raw.has_embedded_default === true,
    subject: str(raw.subject, `${path}.subject`),
  };
  // Absent, not zeroed — a version of 0 beside a template that sends perfectly
  // well reads as a broken row, which is why the producer omits the key.
  if (typeof raw.version === "number") row.version = raw.version;
  if (typeof raw.updated_at === "string") row.updated_at = raw.updated_at;
  if (typeof raw.updated_by === "string") row.updated_by = raw.updated_by;
  return row;
}

export function parseEmailTemplatesPage(value: unknown): EmailTemplatesPage {
  const data = obj(value, "response");
  const templates = data.templates;
  const failures = data.failures;
  if (!Array.isArray(templates)) {
    throw new ShapeError("email templates: templates is not an array");
  }
  if (!Array.isArray(failures)) {
    // Never nil on the wire, and this surface's honesty depends on it. An
    // absent `failures` must be a decode failure rather than an assumed `[]`,
    // or a producer change would turn a partial listing into a complete-looking
    // one in silence.
    throw new ShapeError("email templates: failures is not an array");
  }
  return {
    templates: templates.map((row, index) => parseRow(row, `templates[${index}]`)),
    failures: failures.map((failure, index) => {
      const raw = obj(failure, `failures[${index}]`);
      return {
        source: str(raw.source, `failures[${index}].source`),
        message: str(raw.message, `failures[${index}].message`),
      };
    }),
  };
}

export function parseEmailTemplateDetail(value: unknown): EmailTemplateDetail {
  const data = obj(value, "response");
  const raw = obj(data.template, "template");
  const variables = raw.variables;
  if (!Array.isArray(variables)) {
    throw new ShapeError("email templates: template.variables is not an array");
  }
  return {
    ...parseRow(raw, "template"),
    html_body: str(raw.html_body, "template.html_body"),
    text_body: str(raw.text_body, "template.text_body"),
    variables: variables.map((variable, index) => {
      const item = obj(variable, `template.variables[${index}]`);
      return {
        name: str(item.name, `template.variables[${index}].name`),
        type: str(item.type, `template.variables[${index}].type`),
        required: item.required === true,
      };
    }),
  };
}

// ---- what is actually sending, and what is merely saved --------------------
//
// `state` and `sends_from` answer two different questions and the page renders
// them as two different things. Collapsing them into one badge is the mistake
// this surface exists to prevent (mark8ly#717): a DRAFT row and an ABSENT row
// are different — one is work in progress, one has never been touched — and
// BOTH send the embedded default, because mark8ly's send path filters on
// `status = 'published'`. A single "status" column would show a saved draft as
// though it were live.
//
// So: one column answers "what reaches a customer right now" from
// `sends_from`, and a second answers "what is stored here" from `state`. The
// draft row reads "Built-in default" / "Draft — not sending", the unauthored
// row reads "Built-in default" / "Never edited". Same live answer, visibly
// different reasons.

export interface Described {
  label: string;
  detail: string;
}

/** What a send would use RIGHT NOW. Derived from `sends_from` only. */
export function sendingNow(row: Pick<EmailTemplateRow, "sends_from" | "has_embedded_default">): Described {
  switch (row.sends_from) {
    case "row":
      return {
        label: "Your saved copy",
        detail: "Customers receive the published version stored in mark8ly's registry.",
      };
    case "embedded":
      return {
        label: "Built-in default",
        detail:
          "Customers receive the copy compiled into mark8ly, not anything stored in the registry.",
      };
    case "nothing":
      return {
        label: "Nothing",
        detail: row.has_embedded_default
          ? "This key sends no email at present."
          : "No copy is stored and mark8ly registered no built-in default, so this key sends no email at all.",
      };
  }
}

/** What is STORED here. Derived from `state` only. */
export function savedCopy(row: Pick<EmailTemplateRow, "state">): Described {
  switch (row.state) {
    case "published":
      return { label: "Published", detail: "A saved override exists and is the copy that sends." };
    case "draft":
      return {
        label: "Draft — not sending",
        detail:
          "A saved override exists but is not in use: mark8ly's send path reads published rows only.",
      };
    case "unauthored":
      return {
        label: "Never edited",
        detail: "Nothing has ever been saved here for this key.",
      };
  }
}

/**
 * Said at the moment an operator chooses Draft, not in a legend somewhere.
 *
 * Nothing about the word "draft" implies that the previous copy keeps going
 * out, and an operator who saves a correction as a draft and walks away has
 * changed nothing a customer will see.
 */
export const DRAFT_DOES_NOT_SEND =
  "Saving as a draft changes nothing customers receive — whatever is sending now keeps sending until you publish.";

/**
 * Said when the editor opens a key nobody has authored.
 *
 * The bodies it opens with are mark8ly's EMBEDDED DEFAULT — what is going out
 * today — and not the operator's work. Presenting them as authored copy would
 * make "save" look like a no-op when it is the act that creates an override.
 */
export const UNAUTHORED_OPENS_THE_DEFAULT =
  "This key has never been edited here. The subject and bodies below are mark8ly's built-in default — what is sending right now. Saving stores an override in mark8ly's registry; publishing it is what makes customers see it.";

/**
 * The keys this surface does NOT reach, and where they still live.
 *
 * mark8ly keeps transactional templates in two services with mirrored tables
 * and federation reaches only marketplace-api, so the auth mails are not here
 * (mark8ly#720). Named individually rather than described as "some auth
 * templates": an operator who searches for `password_reset`, finds nothing and
 * concludes it does not exist has been misled by omission, and a vague
 * disclaimer does not fix that.
 */
export const UNREACHABLE_AUTH_KEYS: readonly string[] = [
  "welcome",
  "email_verification",
  "invitation",
  "password_reset",
  "login_otp",
  "new_device_login",
];

export const COVERAGE_NOTE =
  "This page covers mark8ly's marketplace templates only — order documents, gift cards and the billing keys.";

export const COVERAGE_GAP_NOTE =
  "The account and authentication mails are served by a different mark8ly service that federation does not reach yet (mark8ly#720). They are still edited in apps/web, and they are not missing from the list below because they were deleted.";

// ---- test sending is a real send ------------------------------------------

/**
 * The warning that has to be unmissable on the test-send control.
 *
 * `TestSend` goes through mark8ly's production send path to a real provider
 * and a real inbox, and it renders whatever is LIVE for the key — a published
 * row if there is one, the embedded default otherwise — not the unsaved copy
 * in the editor. Both halves matter: an operator testing a fix they have not
 * published will receive the old mail and read it as the fix failing.
 */
export const TEST_SEND_IS_REAL =
  "This sends a real email through mark8ly's production email provider to the address below. It renders whatever is live for this key right now — a published override if there is one, otherwise the built-in default — never unsaved edits in this editor.";

// ---- failure sentences ----------------------------------------------------

/** The four things an operator can be doing here. Each failure names one. */
export type EmailTemplateVerb = "list" | "open" | "save" | "test-send";

interface CaughtShape {
  status?: number;
  code?: string;
  message?: string;
}

/** Structural, never `instanceof` — see this module's header. */
function narrow(caught: unknown): CaughtShape {
  if (typeof caught !== "object" || caught === null) return {};
  const value = caught as Record<string, unknown>;
  return {
    status: typeof value.status === "number" ? value.status : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

/**
 * The one BAD_REQUEST the console can cause itself.
 *
 * `platformRequest` mints an `idempotency-key` for every write here, so this
 * can only be reached if that stops happening — a console bug, not something a
 * retry fixes, and worth saying rather than folding into a generic 400. The
 * header name is matched because it is the only thing that distinguishes this
 * 400 from the others the module can return (`error-no-idempotency-key.json`
 * against `error-bare-key.json`, `error-unknown-source.json`,
 * `error-unknown-field.json`); platform-api carries no finer code than
 * `BAD_REQUEST` for any of them.
 */
function isMissingIdempotencyKey(caught: CaughtShape): boolean {
  return caught.code === "BAD_REQUEST" && /idempotency-key/i.test(caught.message ?? "");
}

const GENERIC: Record<EmailTemplateVerb, string> = {
  list: "The template registry could not be read.",
  open: "This template could not be opened.",
  save: "The template could not be saved. Nothing was changed.",
  "test-send": "The test send could not be made. No message was sent.",
};

/**
 * A caught failure as one sentence an operator can act on.
 *
 * One sentence per code per verb, because the remedies genuinely differ:
 * `SERVICE_UNAVAILABLE` says retry, `EXTERNAL_SERVICE_ERROR` says go and look
 * at mark8ly, `NOT_IMPLEMENTED` says nothing is broken. The upstream `message`
 * is never rendered — it is free text from another product, and for a
 * transport failure it carries hostnames.
 */
export function emailTemplateFailureMessage(verb: EmailTemplateVerb, caught: unknown): string {
  const error = narrow(caught);
  if (isMissingIdempotencyKey(error)) {
    return "The console sent this write without the Idempotency-Key header the platform API requires. Nothing was changed, and retrying will not help — this is a console bug.";
  }

  // Handled ahead of the switch rather than as a case in it: it is the one
  // code whose sentence differs across all four verbs, so it needs a switch of
  // its own, and a nested switch inside a case is a fallthrough waiting to be
  // written.
  if (error.code === "NOT_IMPLEMENTED") {
    // Not a failure. Something is not switched on, and no retry changes that.
    switch (verb) {
      case "list":
      case "open":
        return "No product in this deployment serves an email template registry, so there is nothing to show. This is a configuration state, not an outage.";
      case "save":
        return "mark8ly does not serve this write, so nothing was saved.";
      case "test-send":
        return "mark8ly has no email sending configured, so no test message was sent.";
    }
  }

  switch (error.code) {
    case "VALIDATION_FAILED":
      return verb === "test-send"
        ? "The template could not be rendered for a test send — a variable it uses was not supplied. No message was sent."
        : "mark8ly rejected this template. Check the subject and both bodies for unbalanced {{ }} or an expression it cannot parse. Nothing was saved.";
    case "EXTERNAL_SERVICE_ERROR":
      // The product ANSWERED and refused. Same 503 as below, different next
      // step: look at mark8ly, not at the network.
      return verb === "test-send"
        ? "The email provider rejected the test send. No message was delivered."
        : "mark8ly answered and refused this request. Nothing was changed — check the product before retrying.";
    case "SERVICE_UNAVAILABLE":
      return verb === "save"
        ? "mark8ly could not be reached, so nothing was saved. Retry once it answers."
        : "mark8ly could not be reached. Nothing happened — retry once it answers.";
    case "NOT_FOUND":
      return "No template is stored or registered under this key. Keys are owned by mark8ly's own code, so the console cannot create one.";
    case "BAD_REQUEST":
      return `${GENERIC[verb]} The request was refused as malformed.`;
    default:
      return GENERIC[verb];
  }
}
