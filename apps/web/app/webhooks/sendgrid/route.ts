// SendGrid Event Webhook receiver.
//
// SendGrid POSTs a JSON array of events whenever any of our outbound
// emails change state (delivered, open, click, bounce, etc.). We
// verify the signature, then bulk-insert into email_events so per-
// product / per-tenant dashboards have something to read.
//
// Wave 5 instrumented every send site with custom_args for product,
// tenant_id, kind, template_key, campaign_id, lead_id. Each event in
// the SendGrid payload echoes those custom_args back as top-level
// fields, so we destructure them directly.

import { NextResponse, type NextRequest } from "next/server";
import { insertEmailEvents, type EmailEventInput } from "@/lib/db/email-events";
import { verifySendGridSignature } from "@/lib/sendgrid/webhook";
import { logger } from "@/lib/logger";

// SendGrid's event JSON shape — only the fields we care about. Custom
// args appear at the top level of each event object (not nested).
interface SendGridEvent {
  email?: string;
  event?: string;
  timestamp?: number;
  sg_event_id?: string;
  reason?: string;
  // Wave 5 custom_args echoed back:
  product?: string;
  tenant_id?: string;
  kind?: string;
  template_key?: string;
  campaign_id?: string;
  lead_id?: string;
  // catch-all for anything else SendGrid sends
  [k: string]: unknown;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-twilio-email-event-webhook-signature") ?? "";
  const timestamp =
    req.headers.get("x-twilio-email-event-webhook-timestamp") ?? "";

  const verify = verifySendGridSignature(rawBody, signature, timestamp);
  if (!verify.ok) {
    logger.warn("[sendgrid webhook] signature rejected", {
      message: verify.errorMessage,
    });
    return NextResponse.json(
      { error: "signature_invalid", message: verify.errorMessage },
      { status: 401 },
    );
  }

  let events: SendGridEvent[];
  try {
    events = JSON.parse(rawBody) as SendGridEvent[];
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!Array.isArray(events)) {
    return NextResponse.json({ error: "expected_array" }, { status: 400 });
  }

  const inputs: EmailEventInput[] = events
    .filter((e) => e.sg_event_id && e.event && e.timestamp)
    .map((e) => ({
      sgEventId: String(e.sg_event_id),
      eventType: String(e.event),
      product: typeof e.product === "string" ? e.product : null,
      tenantId: typeof e.tenant_id === "string" ? e.tenant_id : null,
      kind: typeof e.kind === "string" ? e.kind : null,
      templateKey: typeof e.template_key === "string" ? e.template_key : null,
      campaignId: typeof e.campaign_id === "string" ? e.campaign_id : null,
      leadId: typeof e.lead_id === "string" ? e.lead_id : null,
      recipient: typeof e.email === "string" ? e.email : null,
      reason: typeof e.reason === "string" ? e.reason : null,
      raw: e,
      eventAt: new Date((e.timestamp as number) * 1000),
    }));

  try {
    const inserted = await insertEmailEvents(inputs);
    return NextResponse.json({
      received: events.length,
      stored: inserted,
      skipped: verify.skipped,
    });
  } catch (err) {
    logger.error("[sendgrid webhook] insert failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
