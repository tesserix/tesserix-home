"use client";

import { useCallback } from "react";
import { OttoInbox } from "@tesserix/otto-widget";
import { useToast } from "@tesserix/web";

import "@tesserix/otto-widget/styles/inbox.css";

// Cross-tenant "platform mode" inbox for Tesserix support staff. Points the
// widget at the /api/admin/otto platform proxy and the platform WS routes,
// and passes tenantLabels — its PRESENCE switches OttoInbox into platform
// mode (product badge per row + tenant filter chips). Conversations already
// carry tenant_id on the wire, so no backend shape change is needed.
interface PlatformLiveChatInboxProps {
  currentUserId: string;
}

// id -> friendly product name. Any tenant id not in this map falls back to
// its raw id in the badge, so a new product's chats still show (unlabeled)
// until this map is extended. Sourced from every product's OttoWidget
// tenantId across the repos (platform, homechef, fanzone, mark8ly, horoscope,
// stockpilot, scrapper, gameverse, mp-customer).
const TENANT_LABELS: Record<string, string> = {
  platform: "Tesserix",
  homechef: "HomeChef",
  fanzone: "FanZone",
  mark8ly: "mark8ly",
  horoscope: "Horoscope",
  stockpilot: "StockPilot",
  scrapper: "Social Scraper",
  gameverse: "GameVerse",
  "mp-customer": "Marketplace",
};

export function PlatformLiveChatInbox({ currentUserId }: PlatformLiveChatInboxProps) {
  const { toast } = useToast();
  const handleToast = useCallback(
    (tone: "success" | "error" | "info", title: string, description?: string) => {
      toast({
        title,
        description,
        variant:
          tone === "error" ? "destructive" : tone === "success" ? "success" : "default",
      });
    },
    [toast],
  );
  return (
    <OttoInbox
      apiBaseUrl="/api/admin/otto"
      buildInboxWsUrl={buildInboxWsUrl}
      buildConversationWsUrl={buildConversationWsUrl}
      currentUserId={currentUserId}
      onToast={handleToast}
      tenantLabels={TENANT_LABELS}
    />
  );
}

// WS bypasses the Next.js proxy — Istio routes /api/v1/platform/otto/*/ws
// straight to otto (see tesserix-k8s company VirtualService).
function buildInboxWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/platform/otto/ws`;
}

function buildConversationWsUrl(id: string): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/platform/otto/conversations/${encodeURIComponent(id)}/ws`;
}
