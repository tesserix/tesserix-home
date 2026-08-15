"use client";

import { OpenPanelComponent } from "@openpanel/nextjs";

// Self-hosted OpenPanel at analytics.tesserix.app. Renders nothing without a
// client ID so local and preview builds stay out of the production dataset.
export function Analytics() {
  const clientId = process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;

  if (!clientId) {
    return null;
  }

  return (
    <OpenPanelComponent
      clientId={clientId}
      apiUrl={process.env.NEXT_PUBLIC_OPENPANEL_API_URL}
      scriptUrl={process.env.NEXT_PUBLIC_OPENPANEL_SCRIPT_URL}
      trackScreenViews
      trackOutgoingLinks
      trackAttributes
    />
  );
}
