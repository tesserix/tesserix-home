"use client";

import { useState, useTransition } from "react";

import { SEVERITIES, state, targeting, type Announcement, type Audience, type Severity } from "@/lib/announcements";
import {
  createAnnouncementAction,
  previewAudienceAction,
  updateAnnouncementAction,
} from "./actions";

/** The tenant statuses an operator can target. */
//
// A FREE-TEXT list rather than a fixed enum, because `domain.Tenant.Status` is
// documented as "the product's own vocabulary, passed through rather than
// normalised" — mark8ly's "active" and another product's are not guaranteed to
// be the same word. These are the ones mark8ly uses today, offered as
// suggestions; anything typed is sent as typed.
const SUGGESTED_STATUSES = ["active", "trialing", "suspended"];

export function AnnouncementsView({ announcements }: { announcements: Announcement[] }) {
  return (
    <main className="space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Announcements</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Broadcast to merchants across products. Publishing cannot be undone —
          an announcement that goes out wrong is ended, not withdrawn.
        </p>
      </header>

      <Composer />
      <Log announcements={announcements} />
    </main>
  );
}

function Composer() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("info");
  const [products, setProducts] = useState("");
  const [statuses, setStatuses] = useState("");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const list = (raw: string) =>
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  function preview() {
    start(async () => {
      setMessage(null);
      const result = await previewAudienceAction(list(products), list(statuses));
      if (!result.ok) {
        setAudience(null);
        setMessage(result.message);
        return;
      }
      setAudience(result.audience);
    });
  }

  function submit(publish: boolean) {
    start(async () => {
      setMessage(null);
      const result = await createAnnouncementAction({
        title, body, severity,
        products: list(products), statuses: list(statuses), publish,
      });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setTitle(""); setBody(""); setAudience(null);
      setMessage(publish ? "Published." : "Saved as a draft.");
    });
  }

  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="font-medium">New announcement</h2>

      <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Title" maxLength={200} className="w-full rounded border px-2 py-1" />
      <textarea aria-label="Body" value={body} onChange={(e) => setBody(e.target.value)}
        placeholder="Body" rows={4} className="w-full rounded border px-2 py-1" />

      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Severity{" "}
          <select aria-label="Severity" value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
            className="rounded border px-2 py-1">
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Products{" "}
          <input aria-label="Products" value={products} onChange={(e) => setProducts(e.target.value)}
            placeholder="all products" className="rounded border px-2 py-1" />
        </label>
        <label className="text-sm">
          Statuses{" "}
          <input aria-label="Statuses" value={statuses} onChange={(e) => setStatuses(e.target.value)}
            placeholder={`all — e.g. ${SUGGESTED_STATUSES.join(", ")}`}
            className="rounded border px-2 py-1" />
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        Leave products or statuses empty to reach everyone. A status is whatever
        the product itself calls it, so it is typed rather than chosen.
      </p>

      <div className="flex gap-2">
        <button type="button" onClick={preview} disabled={pending}
          className="rounded border px-3 py-1 text-sm">
          Preview audience
        </button>
        <button type="button" onClick={() => submit(false)} disabled={pending}
          className="rounded border px-3 py-1 text-sm">
          Save draft
        </button>
        <button type="button" onClick={() => submit(true)} disabled={pending || audience === null}
          className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50">
          Publish
        </button>
      </div>

      {/* Publish stays disabled until the audience has been previewed. #150
          asks that sending be "a confirmed action naming the audience size",
          and a confirmation nobody was shown is not one. */}
      {audience === null && (
        <p className="text-xs text-muted-foreground">Preview the audience before publishing.</p>
      )}

      {audience && <AudienceSummary audience={audience} />}
      {message && <p className="text-sm">{message}</p>}
    </section>
  );
}

function AudienceSummary({ audience }: { audience: Audience }) {
  return (
    <div className="rounded border border-dashed p-3 text-sm">
      <p>
        Reaches <strong>{audience.countable_total}</strong>{" "}
        {audience.countable_total === 1 ? "tenant" : "tenants"}
        {/* The qualifier is not decoration. Part of the estate cannot be
            counted from here, and a bare total would be read as the whole
            audience — which is the misreading this preview exists to prevent. */}
        {audience.has_uncountable && ", plus an unknown number below"}
      </p>
      <ul className="mt-2 space-y-1">
        {audience.audience.map((entry) => (
          <li key={entry.product}>
            <span className="font-medium">{entry.product}</span>{" "}
            {entry.countable ? (
              <>{entry.count}</>
            ) : (
              <span className="text-muted-foreground">{explain(entry.reason, entry.counted_at_least)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Each reason says what an operator can do about it, which differs. */
function explain(reason: string | undefined, atLeast: number | undefined): string {
  switch (reason) {
    case "not_federated":
      return "not countable — this product does not report tenants";
    case "unavailable":
      return "not countable — the product did not answer; try again";
    case "exceeds_limit":
      return `more than ${atLeast ?? 0} — too many to count exactly`;
    default:
      return "not countable";
  }
}

function Log({ announcements }: { announcements: Announcement[] }) {
  const [pending, start] = useTransition();

  if (announcements.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has been announced yet.</p>;
  }

  return (
    <section className="space-y-2">
      <h2 className="font-medium">All announcements</h2>
      <ul className="divide-y rounded border">
        {announcements.map((a) => {
          const s = state(a);
          const { products, statuses } = targeting(a.audience_filter);
          return (
            <li key={a.id} className="flex items-start justify-between gap-4 p-3">
              <div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  {s} · {a.severity} ·{" "}
                  {products.length > 0 ? products.join(", ") : "all products"} ·{" "}
                  {statuses.length > 0 ? statuses.join(", ") : "all statuses"}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {s === "draft" && (
                  <button type="button" disabled={pending} className="rounded border px-2 py-1 text-xs"
                    onClick={() => start(async () => { await updateAnnouncementAction(a.id, { publish: true }); })}>
                    Publish
                  </button>
                )}
                {(s === "live" || s === "scheduled") && (
                  // "End" rather than "Delete": merchants who have seen it have
                  // seen it, and a delete would promise a recall that does not
                  // exist.
                  <button type="button" disabled={pending} className="rounded border px-2 py-1 text-xs"
                    onClick={() => start(async () => {
                      await updateAnnouncementAction(a.id, { ends_at: new Date().toISOString() });
                    })}>
                    End now
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
