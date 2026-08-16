// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. This directive is load-bearing.
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tesserix/web";

export interface SurfaceTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface SurfaceTabsProps {
  tabs: SurfaceTab[];
  defaultTab?: string;
  /** Names the tablist for screen readers — "Tickets views", not "Tabs". */
  label: string;
}

/**
 * Tabs on their own.
 *
 * `DetailLayout` was the only tabbed component in the kit, and it forces a
 * summary rail and a breadcrumbed header — everything a record page needs and
 * a list page does not. Rather than render a detail layout with an empty rail,
 * the tabbed part is extracted here; `DetailLayout` keeps its own copy for now
 * because folding it in would change that surface's markup, which is a
 * separate change with its own risk.
 *
 * State is local, not in the URL. Both panels are rendered by the server in one
 * pass, so switching is instant and there is nothing to re-fetch; putting the
 * active tab in the query string would also collide with the filter params
 * this surface already owns.
 */
export function SurfaceTabs({ tabs, defaultTab, label }: SurfaceTabsProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  // Same re-sync as DetailLayout: if the active id is not one of the current
  // tabs — because they arrived late, or one was removed — no panel would
  // render at all. Fall back to a real tab whenever that happens.
  const hasActiveTab = tabs.some((tab) => tab.id === active);
  useEffect(() => {
    if (hasActiveTab) return;
    const fallback = tabs.find((tab) => tab.id === defaultTab) ?? tabs[0];
    if (fallback) {
      setActive(fallback.id);
    }
  }, [hasActiveTab, tabs, defaultTab]);

  return (
    <Tabs value={active} onValueChange={setActive}>
      <TabsList aria-label={label}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-4">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
