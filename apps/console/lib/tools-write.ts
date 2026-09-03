// `server-only`: this reads the operator's session and their platform API
// token. A client component importing it must fail the build.
import "server-only";

import { randomUUID } from "node:crypto";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { recordDeniedAttempt } from "@/lib/db/denied-attempts";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";

/**
 * Every write to the internal tools directory goes through here.
 *
 * # Why this is a SIBLING of withCrmWrite and not a caller of it
 *
 * `lib/crm-write.ts` wraps `auditedOperation`, because a CRM write reaches
 * Postgres directly and nothing else would record it. A tools write does not:
 * the Go module records the audit row INSIDE `write.Perform`'s transaction,
 * bound to the row change and the idempotency record, so it cannot survive a
 * rollback of the thing it describes.
 *
 * Reusing withCrmWrite here would write TWO rows to console_audit_log for one
 * edit — and the second would be the less trustworthy of the pair. So this
 * wrapper does session, capability, request and error mapping, and no audit.
 *
 * # Why the capability is checked here as well as by the API
 *
 * The API is the authorisation boundary and answers 403 regardless. This check
 * exists so the console does not send a request it already knows will be
 * refused, and so the failure reads as "you do not have permission" rather
 * than as a transport error.
 */
export type ToolsWriteResult =
  | { ok: true }
  /** `field` names the form input to attach the message to, when the API's
   *  refusal is about one. Absent means it belongs at the form level. */
  | { ok: false; message: string; field?: string };

const NO_PERMISSION = "You do not have permission to change the tools directory.";
const NOT_SAVED = "That change was not saved. Try again shortly.";
const GONE = "That entry may have been removed — reload the page.";
const DUPLICATE_SUBDOMAIN = "A tool with this subdomain already exists.";
const DUPLICATE_GROUP = "A group with this key already exists.";
const GROUP_NOT_EMPTY = "Move or remove the tools in this group first.";

/**
 * Recover the API's own sentence from a PlatformApiError.
 *
 * `unwrapEnvelope` formats as `${label}: ${CODE} — ${message}`, and OUR
 * messages contain em-dashes of their own ("a subdomain must be a single DNS
 * label — lower-case letters..."), so splitting on the first " — " would
 * truncate them. The code is SCREAMING_SNAKE and our messages start
 * lower-case, so anchoring on the code is unambiguous where splitting is not.
 */
function apiMessage(error: PlatformApiError, label: string): string | undefined {
  const withoutLabel = error.message.startsWith(`${label}: `)
    ? error.message.slice(label.length + 2)
    : error.message;
  const match = /^[A-Z_]+ — ([\s\S]+)$/.exec(withoutLabel);
  return match?.[1];
}

/**
 * Which form field a 422 belongs to, inferred from the API's message.
 *
 * A guess, and deliberately a shallow one: the API does not say which field it
 * refused (its `details` carries request PARAMETERS; these are body fields).
 * Guessing wrong costs a message shown at form level instead of under an
 * input; not guessing costs every validation error appearing in the wrong
 * place. Confined to the two prefixes that are unmistakable.
 */
function fieldFor(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (message.startsWith("a subdomain")) return "subdomain";
  if (message.startsWith("a group key")) return "key";
  return undefined;
}

const LABEL = "tools";

async function withToolsWrite(
  run: () => Promise<unknown>,
  mapConflict: (message: string | undefined) => { message: string; field?: string },
): Promise<ToolsWriteResult> {
  const session = await getCurrentSession();
  try {
    await checkOperatorCapabilityLive(session, "platform");
    await run();
    return { ok: true };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      // #265. Unlike `withCrmWrite`, this seam checks OUTSIDE
      // `auditedOperation` — it does not use one at all — so `auditRefusal`
      // never sees the throw and the refusal left no trace anywhere. Recorded
      // here instead, best-effort: it cannot fail the refusal.
      await recordDeniedAttempt({
        actor: session?.sub ?? session?.email ?? "unknown",
        required: cause.required,
        target: LABEL,
        kind: "verb",
      });
      return { ok: false, message: NO_PERMISSION };
    }
    if (cause instanceof PlatformApiError) {
      const message = apiMessage(cause, LABEL);
      switch (cause.status) {
        case 422:
          // The API's own words. It knows which rule was broken and says so in
          // a sentence an operator can act on; paraphrasing here would put a
          // second, staler copy of every validation message in the console.
          return { ok: false, message: message ?? NOT_SAVED, field: fieldFor(message) };
        case 409:
          return { ok: false, ...mapConflict(message) };
        case 404:
          return { ok: false, message: GONE };
        default:
          return { ok: false, message: NOT_SAVED };
      }
    }
    // Anything else — a transport failure, a bug — is not shown verbatim. An
    // operator cannot act on ECONNREFUSED and it names infrastructure.
    return { ok: false, message: NOT_SAVED };
  }
}

function write(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
  return platformRequestWithMeta(LABEL, path, {
    method,
    // Minted per call, same as `platform-api.ts`'s `idempotencyKey()`: the key
    // identifies THIS request. A transport-level retry of it (the browser or
    // an edge hop resending the same call) reuses this key and the Go API
    // answers with the stored result instead of a fresh insert. A genuine
    // resubmission — the operator submitting the form again — mints a NEW key
    // here and IS applied again; this key does not make the form idempotent,
    // only the one request it wraps. Sent unconditionally: DELETE has no body
    // but is exactly as retryable as a POST.
    headers: {
      "idempotency-key": randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export interface ToolInput {
  name: string;
  subdomain: string;
  purpose: string;
  note: string | null;
  groupKey: string;
  sortOrder?: number;
}

export function createTool(input: ToolInput): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () =>
      write("/v1/platform/tools", "POST", {
        name: input.name,
        subdomain: input.subdomain,
        purpose: input.purpose,
        note: input.note,
        group_key: input.groupKey,
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
      }),
    () => ({ message: DUPLICATE_SUBDOMAIN, field: "subdomain" }),
  );
}

/**
 * A partial change.
 *
 * `note` carries three states and all three must survive: absent leaves it
 * alone, an explicit `null` clears it, a string sets it. Hence the
 * `"note" in patch` test rather than a truthiness check — `null` is falsy and
 * would otherwise be dropped, making a note impossible to remove.
 */
export function updateTool(
  id: string,
  patch: Partial<Omit<ToolInput, "note">> & { note?: string | null },
): Promise<ToolsWriteResult> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.subdomain !== undefined) body.subdomain = patch.subdomain;
  if (patch.purpose !== undefined) body.purpose = patch.purpose;
  if (patch.groupKey !== undefined) body.group_key = patch.groupKey;
  if ("note" in patch) body.note = patch.note;
  if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder;

  return withToolsWrite(
    () => write(`/v1/platform/tools/${encodeURIComponent(id)}`, "PATCH", body),
    () => ({ message: DUPLICATE_SUBDOMAIN, field: "subdomain" }),
  );
}

export function deleteTool(id: string): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () => write(`/v1/platform/tools/${encodeURIComponent(id)}`, "DELETE"),
    (message) => ({ message: message ?? NOT_SAVED }),
  );
}

export function createGroup(input: {
  key: string;
  label: string;
  sortOrder?: number;
}): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () =>
      write("/v1/platform/tool-groups", "POST", {
        key: input.key,
        label: input.label,
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
      }),
    () => ({ message: DUPLICATE_GROUP, field: "key" }),
  );
}

/** The key is not changeable — every tool references it, and the API answers
 *  400 explaining what to do instead. Only label and position move. */
export function updateGroup(
  key: string,
  patch: { label?: string; sortOrder?: number },
): Promise<ToolsWriteResult> {
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined) body.label = patch.label;
  if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder;

  return withToolsWrite(
    () => write(`/v1/platform/tool-groups/${encodeURIComponent(key)}`, "PATCH", body),
    (message) => ({ message: message ?? NOT_SAVED }),
  );
}

export function deleteGroup(key: string): Promise<ToolsWriteResult> {
  return withToolsWrite(
    () => write(`/v1/platform/tool-groups/${encodeURIComponent(key)}`, "DELETE"),
    () => ({ message: GROUP_NOT_EMPTY }),
  );
}
