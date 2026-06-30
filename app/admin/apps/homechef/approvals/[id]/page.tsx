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

// The Go API stores the onboarding payload as a JSON column and sometimes
// returns it as a raw JSON *string* rather than an object. Running
// Object.entries() over a string yields [index, character] pairs, which is why
// the panel used to render as a 0:{ 1:" 2:c … character grid. Normalise to an
// object first.
function asObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

// Human-readable rendering for any submitted value: booleans → Yes/No, arrays
// of primitives → comma list, nested objects (address, operating hours) →
// "Key: value · Key: value" so the reviewer can actually read them.
function renderValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    if (v.every((x) => typeof x === "string" || typeof x === "number")) {
      return v.join(", ");
    }
    return v.map((x) => renderValue(x)).join("; ");
  }
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => `${titleCase(k)}: ${renderValue(val)}`);
    return parts.length > 0 ? parts.join(" · ") : "—";
  }
  return String(v);
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
  const [docBusy, setDocBusy] = useState<string | null>(null);
  const { confirm, prompt } = useConfirm();

  // Documents are stored privately in GCS; the detail payload deliberately
  // omits their URLs. Fetch a short-lived signed URL on demand and open it so
  // the reviewer can actually inspect the FSSAI licence / ID proof. The blank
  // tab is opened synchronously (inside the click) to dodge popup blockers,
  // then redirected once the signed URL resolves.
  async function openDocument(docId: string) {
    setError(null);
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    setDocBusy(docId);
    try {
      const { url } = await hcAdmin.get<{ url?: string }>(
        `/approvals/${id}/documents/${docId}`,
      );
      if (url && win) {
        win.location.href = url;
      } else if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        win?.close();
        setError("Document is not available.");
      }
    } catch (e) {
      win?.close();
      setError(e instanceof Error ? e.message : "Could not open document");
    } finally {
      setDocBusy(null);
    }
  }

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

  const submitted = Object.entries(asObject(a.submittedData));
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
            {submitted.map(([k, v]) => {
              const complex = v !== null && typeof v === "object";
              return (
                <div key={k} className={complex ? "col-span-2" : undefined}>
                  <dt className="text-muted-foreground">{titleCase(k)}</dt>
                  <dd className="font-medium text-foreground break-words">{renderValue(v)}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}

      {a.documents && a.documents.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
            Documents ({a.documents.length})
          </h2>
          <ul className="space-y-2 rounded-lg border border-border p-4 text-sm">
            {a.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-foreground">{titleCase(d.type ?? "Document")}</span>
                  {d.fileName ? (
                    <span className="ml-2 truncate text-xs text-muted-foreground">{d.fileName}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => openDocument(d.id)}
                  disabled={docBusy === d.id}
                  className="shrink-0 text-sm font-medium text-primary hover:underline disabled:opacity-50"
                >
                  {docBusy === d.id ? "Opening…" : "View"}
                </button>
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
