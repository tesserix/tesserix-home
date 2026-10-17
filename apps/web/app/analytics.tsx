"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isResearchPath } from "@tesserix/questionnaires";
import { OpenPanelComponent } from "@openpanel/nextjs";

interface AnalyticsConfig {
  clientId: string | null;
  apiUrl: string | null;
  scriptUrl: string | null;
}

// Self-hosted OpenPanel at analytics.tesserix.app. The pages are prerendered at
// build time, so the config the Helm chart injects into the pod has to be read
// from the route handler at runtime. No client ID means no-op.
export function Analytics() {
  const pathname=usePathname();
  const [config, setConfig] = useState<AnalyticsConfig | null>(null);

  useEffect(() => {
    if (isResearchPath(pathname)) return;
    let cancelled = false;
    fetch("/api/analytics-config")
      .then((response) => (response.ok ? response.json() : null))
      .then((loaded) => {
        if (!cancelled) setConfig(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (isResearchPath(pathname) || !config?.clientId) {
    return null;
  }

  return (
    <OpenPanelComponent
      clientId={config.clientId}
      apiUrl={config.apiUrl ?? undefined}
      scriptUrl={config.scriptUrl ?? undefined}
      trackScreenViews
      trackOutgoingLinks
      trackAttributes
    />
  );
}
