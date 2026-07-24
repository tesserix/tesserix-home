// B2 — Test send for a lead template (operator's own inbox).
//
// Renders via the local renderer (lib/templates/render) using sample
// vars and POSTs directly to SendGrid. Unlike the mark8ly product
// templates which proxy to mark8ly's /internal/templates/:key/test,
// these are owned by tesserix-home so we render + send here.

import { NextResponse, type NextRequest } from "next/server";
import { getLeadTemplate } from "@/lib/db/lead-templates";
import { render } from "@/lib/templates/render";
import { sendViaSendGrid } from "@/lib/sendgrid/send";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const FROM = process.env.LEAD_EMAIL_FROM ?? process.env.EMAIL_FROM ?? "noreply@tesserix.app";

interface PostBody {
  to?: string;
  vars?: Record<string, unknown>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let to = (body.to ?? "").trim();
  if (!to) {
    const session = await getCurrentSession().catch(() => null);
    to = session?.email ?? "";
  }
  if (!to) {
    return NextResponse.json({ error: "missing_to" }, { status: 400 });
  }

  const tpl = await getLeadTemplate(key);
  if (!tpl) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Build sample vars: use provided vars where present, else
  // synthesize "sample-<name>" placeholders for declared variables.
  const vars: Record<string, unknown> = { ...(body.vars ?? {}) };
  for (const v of tpl.variables) {
    if (vars[v.name] === undefined) vars[v.name] = `sample-${v.name}`;
  }

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

  const result = await sendViaSendGrid({
    to,
    from: FROM,
    subject: subject.output,
    htmlBody: html.output,
    textBody: text.output,
    customArgs: {
      product: tpl.product || "tesserix",
      kind: "template_test",
      template_key: tpl.key,
    },
  });
  if (!result.ok) {
    logger.warn("[lead-templates test-send] sendgrid error", result);
    return NextResponse.json(
      { error: "send_failed", message: result.errorMessage },
      { status: 502 },
    );
  }
  return NextResponse.json({ sent: true, to, messageId: result.messageId });
}
