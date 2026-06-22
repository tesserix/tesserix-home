"use client";

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { Paginated, ReviewRow } from "@/lib/products/homechef/contracts";

function ratingTone(r: number): Tone {
  if (r >= 4) return "success";
  if (r >= 3) return "warning";
  return "danger";
}

export default function HomechefReviewsPage() {
  const [view, setView] = useState<"visible" | "hidden">("visible");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { prompt } = useConfirm();

  const { data, isLoading, mutate } = useSWR<Paginated<ReviewRow>>(
    ["/reviews", { hidden: view === "hidden" ? "true" : "", page: 1, limit: 50 }],
    swrFetcher,
  );

  async function hide(r: ReviewRow) {
    const reason = await prompt({
      title: "Hide review",
      message: "This hides the review from the chef's page. The reason is kept for audit.",
      label: "Reason",
      placeholder: "e.g. abusive language / spam",
      multiline: true,
      required: true,
      confirmLabel: "Hide review",
      tone: "destructive",
    });
    if (reason === null) return;
    setError(null);
    setBusyId(r.id);
    try {
      await hcAdmin.put(`/reviews/${r.id}/hide`, { reason });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function unhide(r: ReviewRow) {
    setError(null);
    setBusyId(r.id);
    try {
      await hcAdmin.put(`/reviews/${r.id}/unhide`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const reviews = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Reviews</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} ${view}` : "Moderation"}
        </p>
      </div>

      <div className="flex gap-1">
        {(["visible", "hidden"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-sm capitalize ${
              view === v
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews.</p>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => {
            const busy = busyId === r.id;
            return (
              <div key={r.id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex items-center justify-between">
                  <StatusBadge label={`${r.rating?.toFixed(1) ?? "0.0"}★`} tone={ratingTone(r.rating)} />
                  <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                </div>
                <p className="text-sm text-foreground">{r.text || r.comment || "No comment"}</p>
                {r.isHidden && r.hiddenReason ? (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                    Hidden: {r.hiddenReason}
                  </p>
                ) : null}
                <div className="mt-3">
                  {r.isHidden ? (
                    <button
                      disabled={busy}
                      onClick={() => unhide(r)}
                      className="text-sm font-medium text-green-700 hover:underline disabled:opacity-50 dark:text-green-400"
                    >
                      Unhide review
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => hide(r)}
                      className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                    >
                      Hide review
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
