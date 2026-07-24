"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import Link from "next/link";

import { formatDate, formatDateTime, formatINR, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import type { ChefWithStats, Paginated } from "@/lib/products/homechef/contracts";

const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "verified", label: "Verified" },
  { key: "suspended", label: "Suspended" },
];

function chefStatus(c: ChefWithStats): { label: string; tone: Tone } {
  if (!c.isVerified) return { label: "Pending", tone: "warning" };
  if (!c.isActive) return { label: "Suspended", tone: "danger" };
  return { label: "Verified", tone: "success" };
}

// A compliance document for a kitchen (FSSAI licence, ID proof, …) plus its
// per-document verification state. Mirrors GET /chefs/:id/documents; extra
// fields on the wire are ignored.
interface ChefDocument {
  id: string;
  type: string;
  fileName: string;
  fileUrl?: string;
  status: "pending" | "verified" | "rejected";
  rejectionReason?: string;
  expiryDate?: string;
  contentType?: string;
}

interface ChefDocumentsResponse {
  documents: ChefDocument[];
  kitchenPhotos: string[];
}

function docTone(status: ChefDocument["status"]): Tone {
  if (status === "verified") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

// Kitchen media are bare URLs, so video is inferred from the extension.
function isVideoUrl(url: string, contentType?: string): boolean {
  if (contentType?.startsWith("video/")) return true;
  return /\.(mp4|mov|webm)(\?|$)/i.test(url);
}

// Compliance documents + kitchen photos/video for one kitchen, verifiable in
// place. Rendered only inside the open detail row, so the SWR fetch below is
// scoped to the expanded chef and never runs for collapsed rows.
function ChefDocuments({ chefId }: { chefId: string }) {
  const { prompt } = useConfirm();
  const { data, isLoading, error, mutate } = useSWR<ChefDocumentsResponse>(
    [`/chefs/${chefId}/documents`],
    swrFetcher,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function verify(docId: string, verified: boolean) {
    setActionError(null);
    let reason = "";
    if (!verified) {
      const r = await prompt({
        title: "Reject document",
        message: "Tell the chef why this document was rejected.",
        label: "Reason",
        placeholder: "e.g. FSSAI licence expired / photo unreadable",
        multiline: true,
        required: true,
        confirmLabel: "Reject document",
        tone: "destructive",
      });
      if (r === null) return;
      reason = r;
    }
    setBusyId(docId);
    try {
      await hcAdmin.put(
        `/documents/${docId}/verify`,
        verified ? { verified: true } : { verified: false, reason },
      );
      await mutate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const documents = data?.documents ?? [];
  const photos = data?.kitchenPhotos ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Documents &amp; kitchen media
      </h3>

      {actionError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {actionError}
        </div>
      ) : null}

      <div>
        <dt className="mb-1.5 text-xs text-muted-foreground">Compliance documents</dt>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-700 dark:text-red-300">
            Couldn&apos;t load documents.
          </p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents uploaded.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {documents.map((doc) => {
              const busy = busyId === doc.id;
              return (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {titleCase(doc.type) || "Document"}
                      </span>
                      <StatusBadge label={titleCase(doc.status)} tone={docTone(doc.status)} />
                    </div>
                    <div className="text-xs text-muted-foreground">{doc.fileName}</div>
                    {doc.expiryDate ? (
                      <div className="text-xs text-muted-foreground">
                        Expires {formatDate(doc.expiryDate)}
                      </div>
                    ) : null}
                    {doc.status === "rejected" && doc.rejectionReason ? (
                      <div className="text-xs text-red-700 dark:text-red-300">
                        Rejected: {doc.rejectionReason}
                      </div>
                    ) : null}
                    {doc.fileUrl ? (
                      <a
                        href={doc.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-xs font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        View / download
                      </a>
                    ) : (
                      <span className="inline-block text-xs text-muted-foreground">
                        File unavailable
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      disabled={busy || doc.status === "verified"}
                      onClick={() => verify(doc.id, true)}
                    >
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || doc.status === "rejected"}
                      onClick={() => verify(doc.id, false)}
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <dt className="mb-1.5 text-xs text-muted-foreground">Kitchen photos &amp; video</dt>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No kitchen photos or video.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {photos.map((url) => {
              const video = isVideoUrl(url);
              return video ? (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-20 w-20 items-center justify-center rounded-md border border-border bg-muted text-xs font-medium text-muted-foreground hover:bg-muted/70"
                >
                  Video
                </a>
              ) : (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-md focus:outline-none focus:ring-2 focus:ring-foreground/20"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt="Kitchen photo"
                    loading="lazy"
                    className="h-20 w-20 rounded-md border border-border object-cover"
                  />
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Chef metadata, expanded in place.
//
// There is deliberately no fetch here: the Go API has no GET /admin/chefs/:id
// (only the list, plus /chefs/fssai-locked), and every field below already
// arrives on the list row. Inventing a detail request would mean either a new
// backend endpoint or an N+1 that returns exactly what we already hold. The
// mobile admin resolves detail from the list for the same reason.
//
// What ISN'T on the row — documents, payouts, FSSAI history — is linked out to
// the section that owns it rather than half-rendered here.
function ChefDetail({ chef }: { chef: ChefWithStats }) {
  const facts: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Kitchen type", value: chef.kitchenType ? titleCase(chef.kitchenType) : "—" },
    { label: "Cuisines", value: chef.cuisines?.length ? chef.cuisines.join(", ") : "—" },
    { label: "Owner", value: chef.ownerName || "—" },
    { label: "Email", value: chef.ownerEmail || "—" },
    { label: "Phone", value: chef.ownerPhone || "—" },
    { label: "Joined", value: formatDateTime(chef.createdAt) },
    { label: "Menu items", value: String(chef.menuItemCount) },
    { label: "Documents", value: String(chef.documentCount) },
    { label: "Total orders", value: String(chef.totalOrders) },
    { label: "Total revenue", value: formatINR(chef.totalRevenue) },
    { label: "Rating", value: `${chef.rating?.toFixed(1) ?? "0.0"}★` },
    {
      label: "Accepting orders",
      value: chef.acceptingOrders ? "Yes" : "No",
    },
    { label: "Online status", value: chef.onlineStatus ? titleCase(chef.onlineStatus) : "—" },
  ];

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-xs text-muted-foreground">{f.label}</dt>
            <dd className="text-sm text-foreground">{f.value}</dd>
          </div>
        ))}
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <dt className="text-xs text-muted-foreground">Chef ID</dt>
          <dd className="font-mono text-xs text-foreground">{chef.id}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Link
          href={`/admin/apps/homechef/orders?chefId=${chef.id}`}
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Orders
        </Link>
        <Link
          href={`/admin/apps/homechef/payouts?chefId=${chef.id}`}
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Payouts
        </Link>
        <Link
          href={`/admin/apps/homechef/reviews?chefId=${chef.id}`}
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Reviews
        </Link>
        <Link
          href={`/admin/apps/homechef/approvals?search=${encodeURIComponent(chef.businessName ?? "")}`}
          className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/70"
        >
          Approval + documents
        </Link>
      </div>

      <ChefDocuments chefId={chef.id} />
    </div>
  );
}

export default function HomechefChefsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt } = useConfirm();

  const { data, isLoading, mutate } = useSWR<Paginated<ChefWithStats>>(
    ["/chefs", { search, status, page: 1, limit: 50 }],
    swrFetcher,
  );

  async function act(id: string, action: "verify" | "suspend" | "reject") {
    setError(null);
    let reason = "";
    if (action === "reject") {
      const r = await prompt({
        title: "Reject application",
        message: "Tell the chef why their application was rejected.",
        label: "Reason",
        placeholder: "e.g. FSSAI licence missing / not a home kitchen",
        multiline: true,
        required: true,
        confirmLabel: "Reject application",
        tone: "destructive",
      });
      if (r === null) return;
      reason = r;
    } else {
      const ok = await confirm({
        title: action === "verify" ? "Verify kitchen" : "Suspend kitchen",
        message:
          action === "verify"
            ? "Approve this home kitchen? It will go live and can receive orders."
            : "Suspend this kitchen? It will stop receiving orders immediately.",
        confirmLabel: action === "verify" ? "Verify" : "Suspend",
        tone: action === "suspend" ? "destructive" : "default",
      });
      if (!ok) return;
    }
    setBusyId(id);
    try {
      await hcAdmin.put(`/chefs/${id}/${action}`, action === "reject" ? { reason } : undefined);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const chefs = data?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Chefs / Kitchens</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.pagination.total} home kitchens` : "Home kitchens"} · verify, reject &
          suspend
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by business or owner…"
          className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm"
        />
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatus(f.key)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                status === f.key
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Kitchen</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Orders</th>
              <th className="px-4 py-3">Revenue</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : chefs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  No chefs found.
                </td>
              </tr>
            ) : (
              chefs.map((c) => {
                const s = chefStatus(c);
                const busy = busyId === c.id;
                return (
                  <Fragment key={c.id}>
                  <tr className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setOpenId(openId === c.id ? null : c.id)}
                        className="text-left"
                        aria-expanded={openId === c.id}
                        aria-controls={`chef-detail-${c.id}`}
                      >
                        <div className="font-medium text-foreground underline-offset-2 hover:underline">
                          {c.businessName || "Unnamed kitchen"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.rating?.toFixed(1) ?? "0.0"}★ · {c.menuItemCount} items ·{" "}
                          {openId === c.id ? "hide details" : "details"}
                        </div>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-foreground">{c.ownerName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{c.ownerEmail}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{c.totalOrders}</td>
                    <td className="px-4 py-3 tabular-nums">{formatINR(c.totalRevenue)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={s.label} tone={s.tone} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {!c.isVerified ? (
                          <>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => act(c.id, "verify")}
                            >
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => act(c.id, "reject")}
                            >
                              Reject
                            </Button>
                          </>
                        ) : c.isActive ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => act(c.id, "suspend")}
                          >
                            Suspend
                          </Button>
                        ) : (
                          <Button size="sm" disabled={busy} onClick={() => act(c.id, "verify")}>
                            Reinstate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openId === c.id ? (
                    <tr id={`chef-detail-${c.id}`} className="bg-muted/20">
                      <td colSpan={6} className="px-4 py-4">
                        <ChefDetail chef={c} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
