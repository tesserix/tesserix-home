"use client";

import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecoveryOperation, RecoveryStatus } from "@/lib/recovery";
import { ConsoleDataTable, type Column } from "@/components/kit/console-data-table";
import { resolveState } from "@/components/kit/surface-state";
import { startRecoveryAction } from "./actions";

const columns: Column<RecoveryStatus["backups"][number]>[] = [
  { key: "id", header: "Backup", cell: (backup) => <span className="font-mono text-xs">{backup.id}</span> },
  { key: "created", header: "Captured (UTC)", cell: (backup) => <time dateTime={backup.created}>{new Date(backup.created).toLocaleString("en-GB", { timeZone: "UTC" })}</time> },
  { key: "bytes", header: "Size", cell: (backup) => `${Math.ceil(backup.bytes / 1024)} KiB` },
  { key: "restoreSeconds", header: "Restore test", cell: (backup) => `Passed · ${backup.restoreSeconds.toFixed(1)}s` },
  { key: "openbaoVersion", header: "OpenBao", cell: (backup) => backup.openbaoVersion },
];

function OperationForm({ operation, requestKey, disabled }: { operation: RecoveryOperation; requestKey: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(startRecoveryAction, { ok: false, message: "" });
  return <form action={action} className="flex flex-col gap-2">
    <input type="hidden" name="operation" value={operation} />
    <input type="hidden" name="idempotencyKey" value={requestKey} />
    <button type="submit" disabled={pending || disabled} className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50">
      {pending ? "Starting…" : operation === "backup" ? "Back up now" : "Test restore"}
    </button>
    {state.message ? <p role="status" className="max-w-sm text-sm text-muted-foreground">{state.message}</p> : null}
  </form>;
}

export function RecoveryPanel({ status, canRun, requestKey }: { status: RecoveryStatus; canRun: boolean; requestKey: string }) {
  const router = useRouter();
  const [refreshing, refresh] = useTransition();
  return <div className="flex flex-col gap-6">
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border p-5">
      <div><h2 className="font-semibold">{status.backups.length} of 3 recovery points retained</h2><p className="mt-1 text-sm text-muted-foreground">Backups run at 03:00 and 15:00 UTC. Each backup passes an isolated restore test before retention.</p></div>
      <div className="flex flex-wrap gap-3">
        {canRun ? <><OperationForm operation="backup" requestKey={requestKey} /><OperationForm operation="restore-test" requestKey={requestKey} disabled={status.backups.length === 0} /></> : <p className="text-sm text-muted-foreground">Credential-management permission is required to start an operation.</p>}
        <button type="button" onClick={() => refresh(() => router.refresh())} disabled={refreshing} className="h-10 rounded-md border px-4 text-sm disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh status"}</button>
      </div>
    </section>
    <section className="overflow-x-auto rounded-lg border">
      <h2 className="p-4 font-semibold">Verified backups</h2>
      <ConsoleDataTable columns={columns} rows={status.backups} rowKey={(backup) => backup.id} total={status.backups.length} page={1} pageSize={3} onPageChange={() => undefined} state={resolveState({ isLoading: false, error: null, rows: status.backups, filtered: false })} emptyMessage="No verified recovery point is available yet." label="Verified backups" />
    </section>
    <section className="rounded-lg border p-4"><h2 className="font-semibold">Recent operations</h2>{!status.jobsComplete ? <p className="mt-2 text-sm text-muted-foreground">Showing a limited set of recent operations.</p> : null}{status.jobs.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No recent manual operations.</p> : <ul className="mt-3 divide-y">{status.jobs.map((job) => <li key={job.name} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{job.operation === "backup" ? "Backup" : "Isolated restore test"}<span className="ml-2 font-mono text-xs text-muted-foreground">{job.name}</span></span><span>{job.phase}</span></li>)}</ul>}</section>
    <p className="text-sm text-muted-foreground">Test restore runs in an isolated instance. Restoring production requires a separate operator-approved recovery procedure.</p>
  </div>;
}
