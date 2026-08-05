"use client";

// The FSSAI filing queue — chefs who have paid us to obtain their registration.
//
// FSSAI exposes no API, so the actual filing is a person on FoSCoS. This screen
// is what that person works from: the applicant's details to type in, their
// documents to download, and the status to set afterwards. Every status set
// here is what the chef's tracker shows, so the wording is written for them.

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import {
  formatDate,
  FSSAI_STATUS_LABELS,
  FSSAI_TRANSITIONS,
  fssaiTransitionRequires,
  type FssaiRequestListResponse,
  type FssaiRequestRow,
  type FssaiRequestStatus,
} from "@tesserix/homechef-shared";
import { useConfirm } from "@/components/admin/confirm-dialog";

const DOC_LABELS: Record<string, string> = {
  photo: "Passport photo",
  identity: "Government photo ID",
  address_proof: "Address proof",
};

function money(amount: number, currency: string): string {
  return `${currency === "INR" ? "₹" : `${currency} `}${amount.toFixed(2)}`;
}

export function FssaiRequestsPanel() {
  // Defaults to the work — paid and unfinished. `all` includes the history.
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, mutate } = useSWR<FssaiRequestListResponse>(
    ["/fssai/requests", { all: showAll ? "true" : undefined }],
    swrFetcher,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = data?.requests ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Loading…"
            : `${rows.length} request${rows.length === 1 ? "" : "s"}${showAll ? "" : " needing work"}`}
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show open only" : "Show all"}
        </Button>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      ) : null}

      {!isLoading && rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {showAll
            ? "No filing requests yet."
            : "Nothing waiting. Paid requests appear here the moment a chef submits one."}
        </p>
      ) : null}

      <div className="space-y-3">
        {rows.map((r) => (
          <RequestCard
            key={r.id}
            request={r}
            open={openId === r.id}
            onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            onChanged={() => void mutate()}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

function RequestCard({
  request: r,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  request: FssaiRequestRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { prompt } = useConfirm();

  const nextStates = FSSAI_TRANSITIONS[r.status] ?? [];

  // Moving a request needs the field that makes the new status meaningful —
  // the server refuses without it, so it is collected before the call rather
  // than after a failed one.
  async function move(to: FssaiRequestStatus) {
    onError(null);
    const needs = fssaiTransitionRequires(to);
    const body: Record<string, string> = { status: to };

    if (needs) {
      const already =
        needs === "applicationRef"
          ? r.applicationRef
          : needs === "registrationNo"
            ? r.registrationNo
            : undefined;
      const value = await prompt({
        title: FSSAI_STATUS_LABELS[to],
        message: PROMPTS[needs] ?? "",
        label: LABELS[needs] ?? needs,
        defaultValue: already ?? "",
        required: true,
        confirmLabel: "Save",
      });
      if (value === null) return;
      body[needs] = value;
    }

    setBusy(true);
    try {
      await hcAdmin.patch(`/fssai/requests/${r.id}`, body);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update the request");
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const note = await prompt({
      title: "Internal note",
      message: "Only staff see this. The chef never does.",
      label: "Note",
      defaultValue: r.adminNotes ?? "",
      required: true,
      confirmLabel: "Save note",
    });
    if (note === null) return;
    setBusy(true);
    try {
      await hcAdmin.patch(`/fssai/requests/${r.id}`, { adminNotes: note });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 p-4 text-left"
      >
        <div className="min-w-0">
          <p className="font-medium text-foreground">{r.kitchenName}</p>
          <p className="text-xs text-muted-foreground">
            {r.applicantName} · {r.termYears} year{r.termYears === 1 ? "" : "s"} ·{" "}
            {money(r.feeTotal, r.currency)} paid
            {r.paidAt ? ` · ${formatDate(r.paidAt)}` : ""}
            {r.mode && r.mode !== "live" ? ` · ${r.mode.toUpperCase()}` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-medium">
          {FSSAI_STATUS_LABELS[r.status] ?? r.status}
        </span>
      </button>

      {open ? (
        <div className="space-y-5 border-t border-border p-4">
          {/* Everything the filer types into FoSCoS, in one block to copy from. */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Application details
            </h4>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <Detail label="Kitchen" value={r.kitchenName} />
              <Detail label="Applicant" value={r.applicantName} />
              <Detail label="Phone" value={r.contactPhone} />
              <Detail label="Email" value={r.contactEmail} />
              <Detail
                label="Address"
                value={[r.addressLine1, r.addressLine2, r.city, r.state, r.postalCode]
                  .filter(Boolean)
                  .join(", ")}
              />
              <Detail label="Term" value={`${r.termYears} year${r.termYears === 1 ? "" : "s"}`} />
              <Detail label="Payment ref" value={r.paymentRef || "—"} />
              <Detail label="Request id" value={r.id} />
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Kind of business: <strong>Home Based Canteens / Dabba Wallas</strong>, turnover up
              to ₹1.5Cr — Registration, not Licence.
            </p>
          </section>

          {/* Signed for fifteen minutes: these are Aadhaar and PAN images, so a
              link that outlives the screen is a copy loose in a log. */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Documents
            </h4>
            {r.documents.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None attached.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {r.documents.map((d) => (
                  <li key={d.kind} className="flex items-center justify-between gap-3">
                    <span>
                      {DOC_LABELS[d.kind] ?? d.kind}
                      <span className="ml-2 text-xs text-muted-foreground">{d.fileName}</span>
                    </span>
                    {d.fileUrl ? (
                      <a
                        href={d.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-medium underline"
                      >
                        Open / download
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">unavailable</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Links expire after 15 minutes. Reopen this page for a fresh one.
            </p>
          </section>

          {(r.applicationRef || r.registrationNo || r.infoRequested || r.rejectedReason) && (
            <section className="space-y-1 text-sm">
              {r.applicationRef ? <Detail label="FoSCoS reference" value={r.applicationRef} /> : null}
              {r.registrationNo ? <Detail label="Registration no" value={r.registrationNo} /> : null}
              {r.infoRequested ? <Detail label="Asked the chef for" value={r.infoRequested} /> : null}
              {r.rejectedReason ? <Detail label="Rejection reason" value={r.rejectedReason} /> : null}
              {r.licenseFileUrl ? (
                <p>
                  <a href={r.licenseFileUrl} target="_blank" rel="noreferrer" className="underline">
                    Issued certificate ({r.licenseFileName || "download"})
                  </a>
                </p>
              ) : null}
            </section>
          )}

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Move this request
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              The chef sees this on their tracker straight away.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {nextStates.length === 0 ? (
                <span className="text-sm text-muted-foreground">Finished — nothing to move.</span>
              ) : (
                nextStates.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={s === "rejected" || s === "refunded" ? "outline" : "default"}
                    disabled={busy}
                    onClick={() => void move(s)}
                  >
                    {FSSAI_STATUS_LABELS[s]}
                  </Button>
                ))
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void addNote()}>
                Internal note
              </Button>
            </div>
            {r.adminNotes ? (
              <p className="mt-2 rounded-md bg-muted p-2 text-xs">{r.adminNotes}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

const PROMPTS: Record<string, string> = {
  applicationRef:
    "The FoSCoS application reference. This is what lets the chef track their own application with the state authority.",
  registrationNo: "The registration number from the issued certificate.",
  rejectedReason: "The chef is shown this word for word. Say what went wrong and what they can do.",
  infoRequested:
    "The chef is shown this word for word. Say exactly what you need — a blurry Aadhaar, a missing address proof.",
};

const LABELS: Record<string, string> = {
  applicationRef: "FoSCoS reference",
  registrationNo: "Registration number",
  rejectedReason: "Reason",
  infoRequested: "What we need",
};

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}
