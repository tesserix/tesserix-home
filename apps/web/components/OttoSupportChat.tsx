"use client";

import { OttoWidget } from "@tesserix/otto-widget";

import "@tesserix/otto-widget/styles/otto.css";
// Local override (loaded after the widget CSS): makes the post-close
// feedback survey scrollable so the Submit button is always reachable.
import "./otto-widget-overrides.css";

// Thin wrapper around the shared otto widget. Routes through the same-origin
// /api/otto proxy (which injects the internal-auth secret + the "platform"
// tenant). The WebSocket leaves Next.js and connects straight to otto via the
// Istio gateway. Identity props are sourced from the server session in the
// layout so logged-in admins skip the OTP step.
interface OttoSupportChatProps {
  userEmail?: string;
  userName?: string;
}

export function OttoSupportChat({ userEmail, userName }: OttoSupportChatProps) {
  return (
    <OttoWidget
      apiBaseUrl="/api/otto"
      buildWsUrl={(id) => buildConversationWsUrl(id)}
      productName="Tesserix Support"
      tenantId="platform"
      customerId={userEmail ?? undefined}
      customerName={userName ?? undefined}
      customerEmail={userEmail ?? undefined}
    />
  );
}

// The WebSocket path leaves the Next.js process and goes directly to otto via
// the Istio gateway — same host, different path prefix.
function buildConversationWsUrl(id: string): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/storefront/otto/conversations/${encodeURIComponent(id)}/ws`;
}
