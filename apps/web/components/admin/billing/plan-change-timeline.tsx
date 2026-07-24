"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@tesserix/web";
import { PlanBadge } from "./plan-badge";

export interface PlanChangeEntry {
  id: string;
  from_plan: string;
  to_plan: string;
  action: string;
  effective_at: string;
  billing_currency: string;
}

interface PlanChangeTimelineProps {
  changes: ReadonlyArray<PlanChangeEntry>;
  collapsedAfter?: number;
}

const ACTION_LABEL: Readonly<Record<string, string>> = {
  upgrade_committed: "Upgrade",
  downgrade_scheduled: "Downgrade scheduled",
  downgrade_committed: "Downgrade",
  downgrade_blocked_over_quota: "Downgrade blocked",
  period_switch_committed: "Period change",
};

export function PlanChangeTimeline({ changes, collapsedAfter = 3 }: PlanChangeTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground">No plan changes recorded.</p>;
  }

  const visible = expanded ? changes : changes.slice(0, collapsedAfter);
  const hidden = changes.length - visible.length;

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {visible.map((c) => (
          <li key={c.id} className="flex items-start gap-3">
            <div className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-foreground/40" aria-hidden="true" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <PlanBadge plan={c.from_plan} />
                <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <PlanBadge plan={c.to_plan} />
                <span className="text-xs text-muted-foreground">
                  {ACTION_LABEL[c.action] ?? c.action}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                <time dateTime={c.effective_at}>{new Date(c.effective_at).toLocaleString()}</time>
                {" · "}
                {c.billing_currency}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} className="text-xs">
          View {hidden} more change{hidden === 1 ? "" : "s"}
        </Button>
      ) : null}
    </div>
  );
}
