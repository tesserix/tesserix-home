// B2 — Send a lead-template email to a specific lead.
//
// Operator picks a template + lead from the leads page; this endpoint:
//   1. Loads the lead (for email + interpolation vars)
//   2. Loads the template
//   3. Renders subject + html + text
//   4. Records an outbound log row (idempotent)
//   5. POSTs to SendGrid with custom_args carrying lead_id + template_key
//   6. Updates the log row with the SendGrid message id (or error)
//
// Idempotency: caller supplies an idempotency_key. Repeat sends with
// the same key are no-ops at the DB layer.

import { NextResponse, type NextRequest } from "next/server";
import { tesserixQuery } from "@/lib/db/tesserix";
import { getLeadTemplate } from "@/lib/db/lead-templates";
import {
  recordOutboundEmail,
  updateOutboundEmail,
} from "@/lib/db/lead-templates";
import { render } from "@/lib/templates/render";
import { sendViaSendGrid } from "@/lib/sendgrid/send";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const FROM = process.env.LEAD_EMAIL_FROM ?? process.env.EMAIL_FROM ?? "noreply@tesserix.app";

interface PostBody {
  templateKey?: string;
  idempotencyKey?: string;
  varOverrides?: Record<string, unknown>;
}

interface LeadRow {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
  status: string;
  owner: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.templateKey) {
    return NextResponse.json({ error: "missing_template_key" }, { status: 400 });
  }
  if (!body.idempotencyKey) {
    return NextResponse.json(
      { error: "missing_idempotency_key" },
      { status: 400 },
    );
  }

  const tpl = await getLeadTemplate(body.templateKey);
  if (!tpl) {
    return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  }
  if (tpl.status === "draft") {
    return NextResponse.json(
      { error: "template_draft", message: "cannot send a draft template" },
      { status: 400 },
    );
  }

  const leadRes = await tesserixQuery<LeadRow>(
    `SELECT id::text, email, name, company, source, status, owner
     FROM leads WHERE id = $1`,
    [id],
  );
  if (leadRes.rows.length === 0) {
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }
  const lead = leadRes.rows[0];

  const session = await getCurrentSession().catch(() => null);
  const sentBy = session?.email ?? "unknown@tesserix";

  // Build vars: lead fields + operator overrides. Operator can
  // override e.g. {Name} when the lead's name is empty.
  const vars: Record<string, unknown> = {
    Email: lead.email,
    Name: lead.name ?? "",
    Company: lead.company ?? "",
    Source: lead.source ?? "",
    Owner: lead.owner ?? "",
    ...(body.varOverrides ?? {}),
  };

  const subject = render(tpl.subject, vars, { mode: "text" });
  const html = render(tpl.htmlBody, vars, { mode: "html" });
  const text = render(tpl.textBody, vars, { mode: "text" });
  if (!subject.ok || !html.ok || !text.ok) {
    return NextResponse.json(
      {
        error: "render_failed",
        message: subject.errorMessage ?? html.errorMessage ?? text.errorMessage,
      },
      { status: 422 },
    );
  }

  // Record BEFORE sending so we have the audit row even if sending
  // crashes mid-flight.
  await recordOutboundEmail({
    idempotencyKey: body.idempotencyKey,
    templateKey: tpl.key,
    templateVersion: tpl.version,
    product: tpl.product || "tesserix",
    leadId: lead.id,
    recipient: lead.email,
    subject: subject.output,
    sentAt: null,
    sgMessageId: null,
    errorMessage: null,
    sentBy,
  });

  const result = await sendViaSendGrid({
    to: lead.email,
    from: FROM,
    subject: subject.output,
    htmlBody: html.output,
    textBody: text.output,
    customArgs: {
      product: tpl.product || "tesserix",
      kind: "lead_email",
      template_key: tpl.key,
      lead_id: lead.id,
    },
  });

  if (!result.ok) {
    await updateOutboundEmail(body.idempotencyKey, {
      errorMessage: result.errorMessage ?? "unknown",
    });
    logger.warn("[leads/send-email] sendgrid error", result);
    return NextResponse.json(
      { error: "send_failed", message: result.errorMessage },
      { status: 502 },
    );
  }

  await updateOutboundEmail(body.idempotencyKey, {
    sgMessageId: result.messageId ?? undefined,
    sentAt: new Date(),
  });
  // Best-effort: bump the lead's last_contacted_at so the operator
  // sees it on the leads list.
  try {
    await tesserixQuery(
      `UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  } catch {
    /* non-fatal */
  }
  return NextResponse.json({
    sent: true,
    leadId: lead.id,
    recipient: lead.email,
    messageId: result.messageId,
  });
}
