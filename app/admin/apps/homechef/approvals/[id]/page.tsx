"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { AlertTriangle } from "lucide-react";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { ApprovalRequest } from "@/lib/products/homechef/contracts";

function statusTone(s: string): Tone {
  if (s === "approved") return "success";
  if (s === "rejected") return "danger";
  return "warning";
}

function Warning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export default function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: a, isLoading, mutate } = useSWR<ApprovalRequest>(
    [`/approvals/${id}`],
    swrFetcher,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt } = useConfirm();

  async function decide(action: "approve" | "reject" | "request-info") {
    setError(null);
    let notes = "";
    if (action === "reject" || action === "request-info") {
      const r = await prompt({
        title: action === "reject" ? "Reject request" : "Request more info",
        message:
          action === "reject"
            ? "Add a note explaining the rejection (shared with the applicant)."
            : "Tell the applicant what's missing.",
        label: "Note",
        placeholder: action === "reject" ? "Reason for rejection…" : "What do you need?",
        multiline: true,
        required: true,
        confirmLabel: action === "reject" ? "Reject" : "Send request",
        tone: action === "reject" ? "destructive" : "default",
      });
      if (r === null) return;
      notes = r;
    } else {
      const ok = await confirm({
        title: "Approve request",
        message: "Approve this request? This triggers the related workflow.",
        confirmLabel: "Approve",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await hcAdmin.put(`/approvals/${id}/${action}`, { notes });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }
  if (!a) {
    return <div className="p-6 text-muted-foreground">Request not found.</div>;
  }

  const submitted = Object.entries(a.submittedData ?? {}).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  const pending = a.status === "pending" || a.status === "info_requested";

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <button
        onClick={() => router.push("/admin/apps/homechef/approvals")}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to approvals
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {a.title || titleCase(a.type)}
          </h1>
          <p className="text-sm text-muted-foreground">{titleCase(a.type)}</p>
        </div>
        <StatusBadge label={titleCase(a.status)} tone={statusTone(a.status)} />
      </div>

      {a.kitchenTypeNonHome ? (
        <Warning text="Submitted kitchen type is NOT a home kitchen — HomeChef onboards home cooks only." />
      ) : null}
      {a.fssaiLooksCommercial ? (
        <Warning text="FSSAI licence looks like a commercial (State/Central) registration — verify this is a home kitchen." />
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {a.description ? (
        <p className="text-sm text-foreground">{a.description}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 text-sm">
        <div>
          <dt className="text-muted-foreground">Priority</dt>
          <dd className="font-medium text-foreground">{titleCase(a.priority)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Submitted</dt>
          <dd className="font-medium text-foreground">{formatDateTime(a.createdAt)}</dd>
        </div>
        {a.reviewedAt ? (
          <div>
            <dt className="text-muted-foreground">Reviewed</dt>
            <dd className="font-medium text-foreground">{formatDateTime(a.reviewedAt)}</dd>
          </div>
        ) : null}
        {a.adminNotes ? (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Admin notes</dt>
            <dd className="font-medium text-foreground">{a.adminNotes}</dd>
          </div>
        ) : null}
      </dl>

      {submitted.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
            Submitted details
          </h2>
          <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 text-sm">
            {submitted.map(([k, v]) => (
              <div key={k}>
                <dt className="text-muted-foreground">{titleCase(k)}</dt>
                <dd className="font-medium text-foreground">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {a.documents && a.documents.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
            Documents ({a.documents.length})
          </h2>
          <ul className="space-y-1 rounded-lg border border-border p-4 text-sm">
            {a.documents.map((d) => (
              <li key={d.id} className="flex justify-between">
                <span className="text-foreground">{titleCase(d.type ?? "Document")}</span>
                <span className="text-muted-foreground">{d.fileName ?? d.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pending ? (
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button disabled={busy} onClick={() => decide("approve")}>
            Approve
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => decide("request-info")}>
            Request more info
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => decide("reject")}>
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}
