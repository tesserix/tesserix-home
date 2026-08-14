"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tesserix/web";
import { SurfaceStateView, type SurfaceState } from "./states";
import { ConsolePageHeader, type Breadcrumbable } from "./page-header";

export interface SummaryField {
  label: string;
  value: ReactNode;
}

export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface DetailLayoutProps {
  title: string;
  description?: string;
  breadcrumbs?: Breadcrumbable[];
  actions?: ReactNode;
  /** The always-visible summary rail: identity facts, not metrics. */
  summary: SummaryField[];
  /** Optional extra rail content below the summary list (badges, links). */
  summaryFooter?: ReactNode;
  tabs: DetailTab[];
  defaultTab?: string;
  state?: SurfaceState;
  onRetry?: () => void;
}

/**
 * Two-column detail surface: a summary rail plus a tabbed body. Modelled on
 * apps/web's tenant-detail-layout, but the sections are supplied by the
 * caller rather than hard-coded to one product's metrics.
 */
export function DetailLayout({
  title,
  description,
  breadcrumbs,
  actions,
  summary,
  summaryFooter,
  tabs,
  defaultTab,
  state,
  onRetry,
}: DetailLayoutProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  // Tabs commonly arrive after an async load, so the initial state can be "" —
  // or point at a tab a later render dropped. Either way no TabsContent would
  // ever render. Re-sync onto a real tab whenever the current one isn't one.
  const hasActiveTab = tabs.some((tab) => tab.id === active);
  useEffect(() => {
    if (hasActiveTab) return;
    const fallback = tabs.find((tab) => tab.id === defaultTab) ?? tabs[0];
    if (fallback) {
      setActive(fallback.id);
    }
  }, [hasActiveTab, tabs, defaultTab]);

  return (
    <div className="flex h-full flex-col">
      <ConsolePageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        actions={actions}
      />

      {state && state.kind !== "ready" ? (
        <div className="p-6">
          <SurfaceStateView
            state={state}
            emptyMessage="This record has no details to show."
            onRetry={onRetry}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-6 p-6 lg:flex-row">
          <aside className="w-full shrink-0 lg:w-72" aria-label="Summary">
            <dl className="space-y-3 border-t border-border pt-3 text-sm">
              {summary.map((field) => (
                <div key={field.label}>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="mt-1 break-words">{field.value}</dd>
                </div>
              ))}
            </dl>
            {summaryFooter ? <div className="mt-4">{summaryFooter}</div> : null}
          </aside>

          <div className="min-w-0 flex-1">
            <Tabs value={active} onValueChange={setActive}>
              <TabsList>
                {tabs.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {tabs.map((tab) => (
                <TabsContent key={tab.id} value={tab.id}>
                  {tab.content}
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </div>
      )}
    </div>
  );
}
