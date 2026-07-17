"use client";

// HomeChef MEDIATION INBOX (#53). Customer↔chef chat is fully admin-mediated:
// there is no direct channel, so a message reaches the other party ONLY when an
// admin relays it here. An unattended inbox doesn't degrade the feature, it
// stops it — nothing is delivered. Migrated from the HomeChef admin-portal into
// the unified Tesserix admin.
//
// piiDetected is the reason a human sits in this loop: the server flags messages
// that look like a phone number or address. Relaying one hands over contact
// details and lets the pair take the order off-platform, so those are called out
// rather than left for the admin to spot in the text.

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime } from "@/lib/products/homechef/format";
import { StatusBadge } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import {
  MEDIATION_ROLE_LABEL,
  type MediatedMessage,
} from "@/lib/products/homechef/contracts";

export default function HomechefMessagingPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  // Poll: these are people waiting on each other, and the queue only moves when
  // an admin is looking at it.
  const { data, isLoading, mutate } = useSWR<{ data: MediatedMessage[] }>(
    ["/messages/inbox"],
    swrFetcher,
    { refreshInterval: 20_000 },
  );

  const inbox = data?.data ?? [];

  async function relay(m: MediatedMessage) {
    if (m.piiDetected) {
      const ok = await confirm({
        title: "Relay a message with contact details?",
        message:
          "This message looks like it contains a phone number or address. Relaying it lets the customer and chef contact each other directly and take the order off-platform.",
        confirmLabel: "Relay anyway",
        tone: "destructive",
      });
      if (!ok) return;
    }

    setBusyId(m.id);
    setError(null);
    try {
      await hcAdmin.post(`/messages/${m.id}/relay`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not relay the message.");
    } finally {
      setBusyId(null);
    }
  }

  async function block(m: MediatedMessage) {
    const ok = await confirm({
      title: "Block this message?",
      message: "It is never delivered. The sender is not told it was blocked.",
      confirmLabel: "Block",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(m.id);
    setError(null);
    try {
      await hcAdmin.post(`/messages/${m.id}/block`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not block the message.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Mediation inbox</h1>
        <p className="text-sm text-muted-foreground">
          Customer and chef messages wait here until you relay them. Nothing reaches the other party
          on its own.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : inbox.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waiting. Everything has been handled.</p>
      ) : (
        <div className="space-y-3">
          {inbox.map((m) => (
            <div
              key={m.id}
              className={`space-y-3 rounded-lg border p-4 ${
                m.piiDetected ? "border-destructive/40 bg-destructive/5" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {MEDIATION_ROLE_LABEL[m.senderRole]} → {MEDIATION_ROLE_LABEL[m.recipientRole]}
                </span>
                <span>·</span>
                <span className="font-mono">order {m.orderId.slice(0, 8)}</span>
                <span>·</span>
                <span>{formatDateTime(m.createdAt)}</span>
                {m.piiDetected ? (
                  <StatusBadge tone="danger" label="Contact details detected" />
                ) : null}
              </div>

              <p className="whitespace-pre-wrap text-sm">{m.content}</p>

              {m.filename ? (
                <p className="text-xs text-muted-foreground">Attachment: {m.filename}</p>
              ) : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void relay(m)}
                  disabled={busyId === m.id}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
                >
                  Relay
                </button>
                <button
                  type="button"
                  onClick={() => void block(m)}
                  disabled={busyId === m.id}
                  className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                >
                  Block
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
