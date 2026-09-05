"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";

import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  saveEmailTemplate,
  testSendEmailTemplate,
  type EmailTemplateUpsert,
} from "@/lib/platform-api";
import { emailTemplateFailureMessage } from "@/lib/email-templates";

// The two writes on this surface gate on DIFFERENT capabilities, and that is
// the point rather than an accident of who wrote them.
//
// Saving a template is `platform`, matching the route and every other
// `mark8ly.*` surface: an estate operator editing one product's records.
// Test-sending is `platform` AND `mass-send`, because it puts a real email in
// front of a real person through mark8ly's production provider — and authoring
// copy is not sending it. `packages/console-core/src/routes.ts` records that
// decision on `mark8ly.emailTemplates` in the same words, and platform-api's
// `emailtemplates` handler stacks the identical pair on the route itself. This
// is the console's own half of that gate, not a substitute for it.
//
// No console-side audit row. mark8ly appends an `email_template_revisions` row
// in the same transaction as the update, so a record written here would be a
// second, weaker claim about a write this console does not know landed — §6's
// rule that the writer audits.

export type EmailTemplateActionResult = { ok: true } | { ok: false; message: string };

const NO_SURFACE_PERMISSION = "You don't have permission to work with mark8ly's email templates.";
const NO_SEND_PERMISSION =
  "You don't have permission to send email. Editing a template and sending one are separate permissions.";

const LIST_PATH = "/mark8ly/email-templates";

/** platform-api's own `maxBodyBytes` (`emailtemplates/.../handler.go`), copied
 *  so the refusal has a sentence. See `saveEmailTemplateAction`. */
const MAX_BODY_BYTES = 1 << 20;

/**
 * Save a template.
 *
 * Publishing and drafting are the SAME call with a different `status`, because
 * that is what mark8ly's schema offers. The consequence an operator has to be
 * told — a draft does not send, and whatever is sending now keeps sending — is
 * said in the editor at the moment the choice is made, not here.
 */
export async function saveEmailTemplateAction(
  id: string,
  input: EmailTemplateUpsert,
): Promise<EmailTemplateActionResult> {
  if (input.status !== "draft" && input.status !== "published") {
    // Refused rather than defaulted: defaulting would choose, on the operator's
    // behalf, whether customers start seeing this copy.
    return { ok: false, message: "Choose whether to save this as a draft or publish it." };
  }
  if (input.subject.trim().length === 0) {
    return { ok: false, message: "Give the template a subject line." };
  }
  if (input.html_body.trim().length === 0 && input.text_body.trim().length === 0) {
    // Both empty is a template that sends a blank email. mark8ly would accept
    // it — it parses fine — so the refusal has to be here.
    return { ok: false, message: "Write an HTML body, a plain-text body, or both." };
  }
  // platform-api reads the body through a one-megabyte `io.LimitReader`, so a
  // larger template arrives truncated mid-JSON and is refused as "the request
  // body is not the expected JSON" — an opaque answer to "my email is long".
  // Checked here so the operator is told what actually happened. The measure is
  // an approximation of the encoded body, not of it exactly; it only has to be
  // close enough to catch a template that cannot fit.
  const size = new TextEncoder().encode(
    input.subject + input.html_body + input.text_body,
  ).length;
  if (size > MAX_BODY_BYTES) {
    return { ok: false, message: "This template is too large to save — the limit is one megabyte." };
  }

  try {
    const session = await getCurrentSession();
    await checkOperatorCapabilityLive(session, "platform");
    await saveEmailTemplate(id, input);
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof CapabilityError
          ? NO_SURFACE_PERMISSION
          : emailTemplateFailureMessage("save", cause),
    };
  }

  // Both paths: the list's `state`/`sends_from` columns and the editor's own
  // header both change on a save, and a stale list would show a draft as
  // published (or the reverse) until something else invalidated it.
  revalidatePath(LIST_PATH);
  revalidatePath(`${LIST_PATH}/${id}`);
  return { ok: true };
}

/**
 * Send a REAL email.
 *
 * `mass-send` on top of `platform`, asserted here rather than inherited from
 * the page: the whole editor is not gated on `mass-send` — an operator may
 * author copy without being able to email anyone — so the verb must carry its
 * own gate or it has none. `platform` is checked first so an operator who
 * holds neither is told the surface refusal, not the send refusal.
 */
export async function testSendEmailTemplateAction(
  id: string,
  to: string,
): Promise<EmailTemplateActionResult> {
  const recipient = to.trim();
  if (recipient.length === 0) {
    return { ok: false, message: "Enter the address to send the test to." };
  }
  // Deliberately NOT a regexp beyond this: what a mail provider accepts is not
  // a pattern this console should own, and platform-api makes the same call.
  if (!recipient.includes("@")) {
    return { ok: false, message: "That does not look like an email address." };
  }

  try {
    const session = await getCurrentSession();
    await checkOperatorCapabilityLive(session, "platform");
    await checkOperatorCapabilityLive(session, "mass-send");
    await testSendEmailTemplate(id, recipient);
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      // Which capability was missing decides which sentence is true. Answering
      // both refusals with the send message would tell an operator who cannot
      // reach this surface at all that they merely lack a send permission.
      return {
        ok: false,
        message: cause.required === "mass-send" ? NO_SEND_PERMISSION : NO_SURFACE_PERMISSION,
      };
    }
    return { ok: false, message: emailTemplateFailureMessage("test-send", cause) };
  }

  // No revalidate: a test send changes nothing stored. Revalidating would
  // suggest it had.
  return { ok: true };
}
