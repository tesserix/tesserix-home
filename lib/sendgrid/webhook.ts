// SendGrid Event Webhook signature verification.
//
// SendGrid signs each event POST with an ECDSA signature in the
// X-Twilio-Email-Event-Webhook-Signature header, plus a timestamp in
// X-Twilio-Email-Event-Webhook-Timestamp. The signed payload is
// `${timestamp}${rawBody}`, signed with the public key configured in
// the SendGrid console for this webhook.
//
// The "signing key" SendGrid surfaces in the console is a base64-
// encoded ECDSA P-256 public key. We verify with Node's built-in
// `crypto.verify`.
//
// In dev, SENDGRID_WEBHOOK_VERIFY=false skips verification so a curl
// can simulate events without setting up SendGrid signed webhooks.

import { createVerify } from "node:crypto";

const VERIFY_ENABLED = process.env.SENDGRID_WEBHOOK_VERIFY !== "false";
const PUBLIC_KEY_B64 = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY ?? "";

export interface VerifyResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly errorMessage: string | null;
}

export function verifySendGridSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
): VerifyResult {
  if (!VERIFY_ENABLED) {
    return { ok: true, skipped: true, errorMessage: null };
  }
  if (!PUBLIC_KEY_B64) {
    return {
      ok: false,
      skipped: false,
      errorMessage: "SENDGRID_WEBHOOK_PUBLIC_KEY is not set",
    };
  }
  if (!signature || !timestamp) {
    return {
      ok: false,
      skipped: false,
      errorMessage: "missing signature or timestamp header",
    };
  }
  // Reject events older than 10 minutes — replay protection.
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec)) {
    return { ok: false, skipped: false, errorMessage: "invalid timestamp" };
  }
  const ageSec = Math.floor(Date.now() / 1000) - tsSec;
  if (Math.abs(ageSec) > 600) {
    return {
      ok: false,
      skipped: false,
      errorMessage: `timestamp ${ageSec}s old (>10min); rejecting`,
    };
  }
  try {
    const verifier = createVerify("SHA256");
    verifier.update(timestamp + rawBody);
    verifier.end();
    const pubKeyPem = base64ToPem(PUBLIC_KEY_B64);
    const sigBytes = Buffer.from(signature, "base64");
    const ok = verifier.verify(pubKeyPem, sigBytes);
    return {
      ok,
      skipped: false,
      errorMessage: ok ? null : "signature verification failed",
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      errorMessage: err instanceof Error ? err.message : "verify error",
    };
  }
}

function base64ToPem(b64: string): string {
  // SendGrid hands us raw base64; convert to PEM by chunking into
  // 64-char lines and wrapping with the SubjectPublicKeyInfo header
  // that node:crypto expects.
  const cleaned = b64.replace(/\s/g, "");
  const lines: string[] = [];
  for (let i = 0; i < cleaned.length; i += 64) {
    lines.push(cleaned.slice(i, i + 64));
  }
  return ["-----BEGIN PUBLIC KEY-----", ...lines, "-----END PUBLIC KEY-----"].join("\n");
}
