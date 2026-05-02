// SendGrid v3 direct send from tesserix-home.
//
// Used by B2 (lead invite / marketing) where tesserix-home is the
// authoring AND sending surface — no product hop. For product
// transactional templates we never call SendGrid directly from here;
// those go through the product's own pipeline (mark8ly's mailers etc).
//
// Wave 5 custom_args pattern: every send carries product + kind +
// template_key (+ optional tenant_id, lead_id, campaign_id) so the
// /webhooks/sendgrid receiver can attribute engagement events back.

import { logger } from "@/lib/logger";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? "";
const TIMEOUT_MS = 15_000;

export interface SendInput {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly customArgs: Readonly<Record<string, string>>;
}

export interface SendResult {
  readonly ok: boolean;
  readonly status: number;
  readonly messageId: string | null;
  readonly errorMessage: string | null;
}

interface SgRequest {
  personalizations: Array<{ to: Array<{ email: string }> }>;
  from: { email: string };
  subject: string;
  content: Array<{ type: string; value: string }>;
  custom_args: Record<string, string>;
  tracking_settings: {
    click_tracking: { enable: boolean; enable_text: boolean };
    open_tracking: { enable: boolean };
    subscription_tracking: { enable: boolean };
  };
}

export async function sendViaSendGrid(input: SendInput): Promise<SendResult> {
  if (!SENDGRID_API_KEY) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorMessage: "SENDGRID_API_KEY not configured",
    };
  }
  if (!input.to || !input.from) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorMessage: "missing to or from",
    };
  }
  if (!input.subject || (!input.htmlBody && !input.textBody)) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorMessage: "missing subject or body",
    };
  }

  // Click + open tracking disabled per-send to match mark8ly's
  // existing transactional sender behavior. Marketing sends could opt
  // in to opens for engagement metrics in a later iteration.
  const payload: SgRequest = {
    personalizations: [{ to: [{ email: input.to }] }],
    from: { email: input.from },
    subject: input.subject,
    content: [
      { type: "text/plain", value: input.textBody || " " },
      { type: "text/html", value: input.htmlBody || " " },
    ],
    custom_args: input.customArgs,
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    },
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.ok) {
      // SendGrid returns the message id in the X-Message-Id header.
      const messageId = res.headers.get("x-message-id");
      return { ok: true, status: res.status, messageId, errorMessage: null };
    }
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      messageId: null,
      errorMessage: body.slice(0, 500),
    };
  } catch (err) {
    logger.warn("[sendgrid] send failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorMessage: err instanceof Error ? err.message : "fetch error",
    };
  } finally {
    clearTimeout(t);
  }
}
