"use client";
import { ConsoleDataTable } from "@/components/kit/console-data-table";
import { Badge } from "./ui";
import type { AuditEvent } from "@/lib/provisioning/types";
const tone = { success: "ok", denied: "warn", error: "bad" } as const;
export function AuditTable({events}:{events:AuditEvent[]}){
 return <ConsoleDataTable<AuditEvent> rows={events} rowKey={e=>String(e.seq)} label="Identity audit" total={events.length} page={1} pageSize={Math.max(1,events.length)} onPageChange={()=>{}} state={{kind:events.length?"ready":"empty"}} emptyMessage="No events." columns={[
 {key:"seq",header:"Seq",cell:e=>e.seq},
 {key:"time",header:"When",cell:e=>new Date(e.occurredAt).toLocaleString()},
 {key:"actor",header:"Actor",cell:e=><span>{e.actorId} ({e.actorType})</span>},
 {key:"action",header:"Action",cell:e=>e.action},
 {key:"target",header:"Target",cell:e=>e.target??"—"},
 {key:"outcome",header:"Outcome",cell:e=><Badge tone={tone[e.outcome]??"muted"}>{e.outcome}</Badge>},
 {key:"request",header:"Request",cell:e=>e.requestId},
 ]}/>;
}
