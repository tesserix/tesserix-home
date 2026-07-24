"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SeverityBadge } from "./severity-badge";
import { cn } from "@/lib/utils";

export interface AuditEvent {
  id: string;
  tenant_id: string;
  tenantName: string;
  store_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  status: string;
  severity: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const STATUS_TONES: Readonly<Record<string, string>> = {
  success: "text-emerald-700",
  failure: "text-rose-700",
};

interface AuditRowProps {
  event: AuditEvent;
}

export function AuditRow({ event }: AuditRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = event.metadata && Object.keys(event.metadata).length > 0;

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/30">
        <td className="px-4 py-3 align-top">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="px-4 py-3 align-top text-xs tabular-nums text-muted-foreground">
          {new Date(event.created_at).toLocaleString()}
        </td>
        <td className="px-4 py-3 align-top">
          <SeverityBadge severity={event.severity} />
        </td>
        <td className={cn("px-4 py-3 align-top text-xs capitalize", STATUS_TONES[event.status])}>
          {event.status}
        </td>
        <td className="px-4 py-3 align-top font-mono text-xs">{event.action}</td>
        <td className="px-4 py-3 align-top text-xs">
          <span className="font-medium">{event.resource_type}</span>
          {event.resource_id ? (
            <span className="ml-1 text-muted-foreground">·{" "}{event.resource_id}</span>
          ) : null}
        </td>
        <td className="px-4 py-3 align-top text-xs">
          <div className="font-medium">{event.actor_email ?? `(${event.actor_type})`}</div>
          <div className="text-muted-foreground">{event.actor_type}</div>
        </td>
        <td className="px-4 py-3 align-top text-xs text-muted-foreground">{event.tenantName}</td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={8} className="px-4 py-3">
            <div className="space-y-2 text-xs">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">IP</dt>
                  <dd className="font-mono">{event.ip_address ?? "—"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">User agent</dt>
                  <dd className="truncate font-mono">{event.user_agent ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Event ID</dt>
                  <dd className="truncate font-mono">{event.id}</dd>
                </div>
              </dl>
              {hasMetadata ? (
                <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              ) : (
                <p className="text-muted-foreground">No metadata.</p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
