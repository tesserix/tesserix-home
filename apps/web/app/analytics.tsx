"use client";

import { OpenPanelComponent } from "@openpanel/nextjs";

interface AnalyticsProps {
  clientId?: string;
  apiUrl?: string;
  scriptUrl?: string;
}

// Self-hosted OpenPanel at analytics.tesserix.app. Config arrives as props from
// the server layout: NEXT_PUBLIC_* would be inlined at build time, but the Helm
// chart supplies these at runtime. No client ID means no-op.
export function Analytics({ clientId, apiUrl, scriptUrl }: AnalyticsProps) {
  if (!clientId) {
    return null;
  }

  return (
    <OpenPanelComponent
      clientId={clientId}
      apiUrl={apiUrl}
      scriptUrl={scriptUrl}
      trackScreenViews
      trackOutgoingLinks
      trackAttributes
    />
  );
}
