/**
 * Merge-field registry and the all-or-nothing renderer behind the CRM lead
 * templates (#LDQ).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *     An unresolved placeholder BLOCKS the copy. It is never substituted
 *     with "", never left as the literal `{{…}}`, and never partially
 *     rendered.
 *
 * "Hi ," is the tell that makes templated outreach read as bulk, and a
 * message that does NOT read as bulk is the entire value of this feature —
 * the whole reason an operator is pasting into Instagram by hand at 20–30
 * DMs a day instead of queueing a send. A renderer that degrades gracefully
 * is a renderer that ships the exact thing we are building this to avoid, so
 * degrading gracefully is the defect, not the fallback.
 *
 * `renderTemplate` therefore returns NO `text` property at all in the
 * failure case, rather than text plus a warning. The alternative — text
 * accompanied by `warnings: [...]` — was rejected because a caller can
 * ignore a warning and cannot ignore an absent field: the composer would
 * have to remember to check, and the day it forgets, the failure is silent
 * and lands in a stranger's DMs. An absent property makes the mistake a
 * TypeScript error at the call site instead.
 *
 * PURE MODULE — no imports from `lib/db`, and none may be added. That keeps
 * it in the node project of `vitest.config.ts` (fast, no PGlite, no DOM) and,
 * more importantly, keeps it impossible for the rendering rule above to
 * acquire a database dependency later and quietly become something only an
 * integration test can exercise. Callers pass values in; this file reads
 * nothing.
 *
 * TWO FAILURE MODES, DELIBERATELY DISTINCT. `missing` means the data is
 * absent for THIS lead — the operator picks another template or another
 * lead, and nothing is wrong with the template. `unknown` means the template
 * references a field that does not exist — an authoring bug that renders
 * nothing for EVERY lead, forever, and needs the author, not the sender.
 * Collapsing the two into one "cannot render" would send an operator hunting
 * for a bio that was never the problem.
 */

/** A value as it arrives from a row: text, a `text[]` column, or absent. */
export type MergeValue = string | string[] | null | undefined;

/** The six allowlisted tokens. Deliberately a closed set — see `MERGE_FIELDS`. */
export type MergeFieldToken = keyof typeof MERGE_FIELDS;

/** Everything a caller can supply. Absent keys are treated as missing values. */
export type MergeValues = Partial<Record<MergeFieldToken, MergeValue>>;

export type RenderResult =
  | { ok: true; text: string; subject?: string }
  | { ok: false; missing: string[] }
  | { ok: false; unknown: string[] };

/**
 * The allowlist. EXACTLY six fields, each naming the column it reads.
 *
 * NOTHING DERIVED OR COMPUTED MAY BE ADDED HERE WITHOUT A COLUMN BEHIND IT.
 * The reason is the rule at the top of this file: a merge field whose value
 * is computed has no null to check. `{{contact.first_name}}` split from
 * `name`, `{{org.city}}` parsed out of `location`, `{{contact.followers_band}}`
 * bucketed from a count — each of those yields "" for some input rather than
 * nothing, so the missing-field branch below can never fire for it, and the
 * first such field is exactly how "Hi ," gets back in. If a template needs a
 * first name, `crm_contacts` gets a `first_name` column with real NULL
 * semantics, and it becomes checkable like everything else.
 *
 * `label` is operator-facing: it is what the preview surface prints when it
 * refuses ("no bio recorded for this contact"), so it reads as English, not
 * as a token.
 */
export const MERGE_FIELDS = Object.freeze({
  "org.name": { label: "organisation name", source: "crm_organisations.name" },
  "org.location": { label: "location", source: "crm_organisations.location" },
  "org.category": { label: "category", source: "crm_organisations.category" },
  "contact.name": { label: "contact name", source: "crm_contacts.name" },
  "contact.instagram_handle": {
    label: "Instagram handle",
    source: "crm_contacts.instagram_handle",
  },
  "contact.biography": { label: "bio", source: "crm_contacts.biography" },
} as const satisfies Record<string, { label: string; source: string }>);

/**
 * Thrown by `parseMergeFields` when a template references a field that does
 * not exist. `createTemplate` lets it propagate, so a bad token is rejected
 * at AUTHORING time — where the person who can fix it is standing — rather
 * than discovered later by an operator trying to send, on someone else's
 * screen.
 *
 * `unknown` is carried on the error as well as in the message so the server
 * action can render the tokens as a list rather than parsing its own prose.
 */
export class UnknownMergeFieldError extends Error {
  constructor(
    readonly unknown: string[],
    message = `This template references ${unknown.length === 1 ? "a merge field that does not exist" : "merge fields that do not exist"}: ${unknown.map((token) => `{{${token}}}`).join(", ")}. Available fields: ${Object.keys(MERGE_FIELDS).join(", ")}.`,
  ) {
    super(message);
    this.name = "UnknownMergeFieldError";
  }
}

/**
 * `{{token}}`, with optional whitespace inside the braces because operators
 * type it that way and `{{ org.name }}` failing as "unknown field ` org.name `"
 * would be a hostile way to teach them otherwise. `[^{}]*?` refuses to span a
 * brace, so an unclosed `{{` cannot swallow the rest of the body.
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function isKnown(token: string): token is MergeFieldToken {
  return Object.hasOwn(MERGE_FIELDS, token);
}

/**
 * One scan, two lists, both deduped and in template order.
 *
 * Non-throwing, unlike the exported `parseMergeFields`, because
 * `renderTemplate` has to REPORT unknown tokens in its union rather than
 * blow up: a preview that threw would give the composer an exception to
 * translate instead of a branch to render. The two callers genuinely want
 * different things from the same scan — authoring wants to be stopped,
 * rendering wants to be told — so the scan is shared and the reaction is not.
 */
function scanMergeFields(...texts: string[]): { tokens: MergeFieldToken[]; unknown: string[] } {
  const tokens: MergeFieldToken[] = [];
  const unknown: string[] = [];

  for (const text of texts) {
    for (const [, raw] of text.matchAll(PLACEHOLDER)) {
      if (isKnown(raw)) {
        if (!tokens.includes(raw)) tokens.push(raw);
      } else if (!unknown.includes(raw)) {
        unknown.push(raw);
      }
    }
  }

  return { tokens, unknown };
}

/**
 * The merge fields a template references, in order, deduped.
 *
 * THROWS `UnknownMergeFieldError` on any token outside the allowlist. It
 * throws rather than returning the unknowns because both of its callers
 * (`createTemplate`, and the authoring form behind it) want the write
 * refused, and an unknown token returned as data is one `if` away from being
 * silently kept — which is the outcome this whole module exists to make
 * impossible.
 */
export function parseMergeFields(...texts: string[]): MergeFieldToken[] {
  const { tokens, unknown } = scanMergeFields(...texts);
  if (unknown.length > 0) throw new UnknownMergeFieldError(unknown);
  return tokens;
}

/**
 * Resolve one value to the string it renders as, or `null` for "missing".
 *
 * WHITESPACE-ONLY IS MISSING. A scrape yields `biography = "  "` routinely
 * (an emoji-only bio stripped of emoji, a profile with a single non-breaking
 * space), and " " substituted into a greeting reads to the recipient exactly
 * like the empty case this file exists to prevent. Trimming only the check,
 * not the value, keeps an author's deliberate leading space in a bio intact.
 *
 * AN EMPTY `text[]` IS MISSING, not an empty string. `crm_organisations.category`
 * is `NOT NULL DEFAULT '{}'`, so "uncategorised" arrives as `[]` rather than
 * NULL — treating that as a rendered empty string would put "You do ." in a
 * DM and would do it for every uncategorised organisation, which is most of a
 * fresh scrape. Blank entries are filtered before the join for the same
 * reason: `["", "Cafe"]` must not render as ", Cafe".
 */
function resolve(value: MergeValue): string | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const present = value.filter((entry) => entry.trim().length > 0);
    return present.length > 0 ? present.join(", ") : null;
  }

  return value.trim().length > 0 ? value : null;
}

/**
 * Substitute in ONE pass over the source text.
 *
 * `String.replaceAll` with a replacer function never re-scans what the
 * replacer returned, which is the property that makes substitution literal:
 * a contact whose scraped bio contains the characters `{{org.name}}` gets
 * those characters in the message, not the organisation's name. Iterating
 * `text = text.replace(token, value)` per field would re-scan and would turn
 * scraped text into a template — a stranger's Instagram bio deciding what our
 * outreach says.
 */
function substitute(text: string, resolved: ReadonlyMap<string, string>): string {
  return text.replaceAll(PLACEHOLDER, (_match, raw: string) => resolved.get(raw) ?? _match);
}

/**
 * Render a template body (and optional subject) against one lead's values.
 *
 * ALL OR NOTHING, ACROSS BOTH FIELDS. A missing field anywhere in the
 * subject fails the body too: an email whose subject line reads "A note for "
 * is not saved by a well-rendered body, and shipping half a message is the
 * same defect wherever it lands.
 *
 * UNKNOWN OUTRANKS MISSING when a template has both. An unknown token is
 * broken for every lead, so telling the operator about this lead's absent bio
 * first would send them to the next lead to hit the identical wall.
 */
export function renderTemplate({
  body,
  subject,
  values,
}: {
  body: string;
  subject?: string | null;
  values: MergeValues;
}): RenderResult {
  const hasSubject = typeof subject === "string" && subject.length > 0;
  const texts = hasSubject ? [body, subject] : [body];

  const { tokens, unknown } = scanMergeFields(...texts);
  if (unknown.length > 0) return { ok: false, unknown };

  const resolved = new Map<string, string>();
  const missing: string[] = [];

  // Template order, because that is the order the operator reads the message
  // in and therefore the order they will look for the gap.
  for (const token of tokens) {
    const value = resolve(values[token]);
    if (value === null) missing.push(token);
    else resolved.set(token, value);
  }

  if (missing.length > 0) return { ok: false, missing };

  const text = substitute(body, resolved);
  return hasSubject ? { ok: true, text, subject: substitute(subject, resolved) } : { ok: true, text };
}
