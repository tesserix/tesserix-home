"use client";

// HomeChef MARKETING CAMPAIGNS (#56). The last slice of retiring
// apps/admin-portal — and the only admin surface that reaches customers OUTSIDE
// an order.
//
// A send goes to everyone the segment matches, at once, and cannot be recalled.
// Everything careful on this screen follows from that:
//   - Preview before send is not optional decoration; it turns "some segment"
//     into a number you agreed to.
//   - Test-send delivers the composed message to you only — a dry run before the
//     irreversible blast.
//   - The send confirm names that number, because "Send now?" doesn't tell you
//     whether you're about to message 12 people or 12,000.
//   - matched vs reachable is shown separately: a customer with no FCM token is
//     matched but unreachable by push. (See the device-token 404 that left every
//     vendor without one — the audience would have looked fine.)

import { useState } from "react";
import useSWR from "swr";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";
import { formatDateTime, titleCase } from "@/lib/products/homechef/format";
import { StatusBadge, type Tone } from "@/components/admin/homechef/status-badge";
import { useConfirm } from "@/components/admin/confirm-dialog";
import {
  parseSegment,
  type Campaign,
  type CampaignInput,
  type CampaignMetrics,
  type CampaignStatus,
  type SegmentCriteria,
  type SegmentPreview,
} from "@/lib/products/homechef/contracts";

const EMPTY: CampaignInput = {
  name: "",
  sendPush: true,
  sendEmail: false,
  pushTitle: "",
  pushBody: "",
  emailSubject: "",
  emailHtml: "",
  segment: { recency: "", subscription: "" },
};

const ROLES = ["customer", "chef", "delivery"];

function statusTone(s: CampaignStatus): Tone {
  switch (s) {
    case "sent":
      return "success";
    case "sending":
    case "queued":
      return "warning";
    case "scheduled":
      return "info";
    default:
      return "neutral";
  }
}

// A campaign is only editable/sendable before it has gone out.
function isTerminal(s: CampaignStatus): boolean {
  return s === "sent" || s === "cancelled" || s === "sending" || s === "queued";
}

// Draft/scheduled campaigns can still be composed against (UpdateCampaign 409s
// once a campaign has left that state).
function isEditable(s: CampaignStatus): boolean {
  return s === "draft" || s === "scheduled";
}

function describeSegment(seg: SegmentCriteria): string {
  const bits: string[] = [];
  if (seg.roles?.length) bits.push(seg.roles.join(", "));
  if (seg.recency === "active") bits.push(`active in ${seg.recencyDays ?? 30}d`);
  if (seg.recency === "lapsed") bits.push(`lapsed ${seg.recencyDays ?? 30}d+`);
  if (seg.subscription) bits.push(`subscription: ${seg.subscription}`);
  if (seg.cities?.length) bits.push(seg.cities.join(", "));
  if (seg.newWithinDays) bits.push(`new within ${seg.newWithinDays}d`);
  return bits.length ? bits.join(" · ") : "Everyone";
}

function fromCampaign(c: Campaign): CampaignInput {
  return {
    name: c.name,
    sendPush: c.sendPush,
    sendEmail: c.sendEmail,
    pushTitle: c.pushTitle,
    pushBody: c.pushBody,
    emailSubject: c.emailSubject,
    emailHtml: c.emailHtml,
    segment: parseSegment(c.segment),
  };
}

// Compose form shared by create (POST /campaigns) and edit (PUT /campaigns/:id).
function CampaignForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: Campaign;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CampaignInput>(initial ? fromCampaign(initial) : EMPTY);
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof CampaignInput>(k: K, v: CampaignInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function setSeg(patch: Partial<SegmentCriteria>) {
    setForm((f) => ({ ...f, segment: { ...f.segment, ...patch } }));
    // Any change to the audience invalidates the number we previewed.
    setPreview(null);
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await hcAdmin.post<SegmentPreview>("/campaigns/preview", { segment: form.segment }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not preview the audience.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    if (!form.name.trim()) return setError("Give the campaign a name.");
    if (!form.sendPush && !form.sendEmail) return setError("Pick at least one channel.");
    if (form.sendPush && !form.pushTitle.trim()) return setError("Push needs a title.");
    if (form.sendEmail && !form.emailSubject.trim()) return setError("Email needs a subject.");

    setBusy(true);
    try {
      if (initial) {
        await hcAdmin.put<Campaign>(`/campaigns/${initial.id}`, form);
      } else {
        await hcAdmin.post<Campaign>("/campaigns", form);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the campaign.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h2 className="text-base font-semibold">{initial ? "Edit campaign" : "New campaign"}</h2>
      {!initial ? (
        <p className="text-sm text-muted-foreground">
          Saved as a draft. Nothing is sent until you send it.
        </p>
      ) : null}

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Name</span>
        <input
          className="w-full rounded-md border px-3 py-2"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Internal name — customers never see this"
        />
      </label>

      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Audience</h3>

        <div className="space-y-1 text-sm">
          <span className="font-medium">Roles</span>
          <div className="flex gap-4">
            {ROLES.map((r) => {
              const on = form.segment.roles?.includes(r) ?? false;
              return (
                <label key={r} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const cur = form.segment.roles ?? [];
                      setSeg({
                        roles: e.target.checked ? [...cur, r] : cur.filter((x) => x !== r),
                      });
                    }}
                  />
                  {titleCase(r)}
                </label>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">Defaults to customers when none are picked.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Recency</span>
            <select
              className="w-full rounded-md border px-3 py-2"
              value={form.segment.recency ?? ""}
              onChange={(e) => setSeg({ recency: e.target.value as SegmentCriteria["recency"] })}
            >
              <option value="">Any</option>
              <option value="active">Recently active</option>
              <option value="lapsed">Lapsed</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Within (days)</span>
            <input
              type="number"
              min={1}
              className="w-full rounded-md border px-3 py-2"
              value={String(form.segment.recencyDays ?? "")}
              onChange={(e) =>
                setSeg({ recencyDays: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Subscription</span>
            <select
              className="w-full rounded-md border px-3 py-2"
              value={form.segment.subscription ?? ""}
              onChange={(e) =>
                setSeg({ subscription: e.target.value as SegmentCriteria["subscription"] })
              }
            >
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Cities</span>
            <input
              className="w-full rounded-md border px-3 py-2"
              value={(form.segment.cities ?? []).join(", ")}
              onChange={(e) =>
                setSeg({
                  cities: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="Bengaluru, Mumbai — comma separated"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">New within (days)</span>
            <input
              type="number"
              min={1}
              className="w-full rounded-md border px-3 py-2"
              value={String(form.segment.newWithinDays ?? "")}
              onChange={(e) =>
                setSeg({ newWithinDays: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="Account age ≤ N days"
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={busy}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {busy ? "Checking…" : "Preview audience"}
          </button>
          {preview ? (
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{preview.matched}</span> matched ·{" "}
              <span className="tabular-nums">{preview.reachablePush}</span> reachable by push ·{" "}
              <span className="tabular-nums">{preview.reachableEmail}</span> by email
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Preview before you send — matched is not the same as reachable.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Message</h3>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.sendPush}
              onChange={(e) => set("sendPush", e.target.checked)}
            />
            Push
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.sendEmail}
              onChange={(e) => set("sendEmail", e.target.checked)}
            />
            Email
          </label>
        </div>

        {form.sendPush ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Push title</span>
              <input
                className="w-full rounded-md border px-3 py-2"
                value={form.pushTitle}
                onChange={(e) => set("pushTitle", e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Push body</span>
              <input
                className="w-full rounded-md border px-3 py-2"
                value={form.pushBody}
                onChange={(e) => set("pushBody", e.target.value)}
              />
            </label>
          </div>
        ) : null}

        {form.sendEmail ? (
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Email subject</span>
              <input
                className="w-full rounded-md border px-3 py-2"
                value={form.emailSubject}
                onChange={(e) => set("emailSubject", e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Email HTML</span>
              <textarea
                rows={6}
                className="w-full rounded-md border px-3 py-2 font-mono text-xs"
                value={form.emailHtml}
                onChange={(e) => set("emailHtml", e.target.value)}
              />
            </label>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {initial ? "Save changes" : "Save draft"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function MetricsRow({ id }: { id: string }) {
  const { data } = useSWR<CampaignMetrics>([`/campaigns/${id}/metrics`], swrFetcher);
  if (!data) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {data.recipients} recipients · push {data.push.sent} sent / {data.push.failed} failed /{" "}
      {data.push.opened} opened · email {data.email.sent} sent / {data.email.failed} failed /{" "}
      {data.email.opened} opened
    </p>
  );
}

// Inline datetime picker to set a future send time (POST /campaigns/:id/schedule).
function SchedulePanel({
  campaign,
  onScheduled,
  onCancel,
}: {
  campaign: Campaign;
  onScheduled: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!value) return setError("Pick a date and time.");
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return setError("That date is not valid.");
    if (at.getTime() <= Date.now()) return setError("Pick a time in the future.");
    setBusy(true);
    setError(null);
    try {
      await hcAdmin.post(`/campaigns/${campaign.id}/schedule`, { scheduledAt: at.toISOString() });
      onScheduled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not schedule the campaign.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-md border px-3 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
      >
        Schedule
      </button>
      <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-xs">
        Cancel
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export default function HomechefCampaignsPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const { data, isLoading, mutate } = useSWR<{ data: Campaign[] }>(
    ["/campaigns", { page: 1, limit: 100 }],
    swrFetcher,
  );
  const campaigns = data?.data ?? [];

  async function send(c: Campaign) {
    setError(null);
    setNotice(null);
    // Resolve the audience FIRST so the confirm can state a real number. Sending
    // is irreversible, and "Send now?" alone doesn't say whether that's 12
    // people or 12,000.
    let preview: SegmentPreview | null = null;
    try {
      preview = await hcAdmin.post<SegmentPreview>("/campaigns/preview", {
        segment: parseSegment(c.segment),
      });
    } catch {
      // Preview is best-effort; fall back to a blunter warning rather than
      // blocking the send on it.
    }

    const audience = preview
      ? `${preview.matched} customers match — ${preview.reachablePush} reachable by push, ${preview.reachableEmail} by email.`
      : "The audience could not be previewed just now.";

    const ok = await confirm({
      title: `Send "${c.name}" now?`,
      message: `${audience} This goes out immediately and cannot be recalled.`,
      confirmLabel: "Send now",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(c.id);
    try {
      await hcAdmin.post(`/campaigns/${c.id}/send`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the campaign.");
    } finally {
      setBusyId(null);
    }
  }

  async function testSend(c: Campaign) {
    const ok = await confirm({
      title: `Send a test of "${c.name}"?`,
      message:
        "Delivers the composed push + email to you only — a safe dry run to check how it lands before the real blast.",
      confirmLabel: "Send test",
    });
    if (!ok) return;

    setBusyId(c.id);
    setError(null);
    setNotice(null);
    try {
      await hcAdmin.post(`/campaigns/${c.id}/test`);
      setNotice(`Test of "${c.name}" sent to you.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the test.");
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(c: Campaign) {
    const ok = await confirm({
      title: `Cancel "${c.name}"?`,
      message: "It won't send. Anything already delivered stays delivered.",
      confirmLabel: "Cancel campaign",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(c.id);
    setError(null);
    try {
      await hcAdmin.post(`/campaigns/${c.id}/cancel`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel the campaign.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c: Campaign) {
    const ok = await confirm({
      title: `Delete "${c.name}"?`,
      message: "Removes this campaign for good. Only drafts and cancelled campaigns can be deleted.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    if (!ok) return;

    setBusyId(c.id);
    setError(null);
    try {
      await hcAdmin.delete(`/campaigns/${c.id}`);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the campaign.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Push and email to a customer segment. A send goes out at once and cannot be recalled —
          preview the audience first.
        </p>
      </div>

      {creating ? (
        <CampaignForm
          onDone={() => {
            setCreating(false);
            void mutate();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          New campaign
        </button>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p> : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">No campaigns yet.</p>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => {
            if (editingId === c.id) {
              return (
                <CampaignForm
                  key={c.id}
                  initial={c}
                  onDone={() => {
                    setEditingId(null);
                    void mutate();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
            const seg = parseSegment(c.segment);
            return (
              <div key={c.id} className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{c.name}</h3>
                      <StatusBadge tone={statusTone(c.status)} label={c.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {describeSegment(seg)} ·{" "}
                      {[c.sendPush ? "push" : null, c.sendEmail ? "email" : null]
                        .filter(Boolean)
                        .join(" + ")}
                      {c.sentAt ? ` · sent ${formatDateTime(c.sentAt)}` : ""}
                      {c.scheduledAt && !c.sentAt
                        ? ` · scheduled ${formatDateTime(c.scheduledAt)}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!isTerminal(c.status) ? (
                      <button
                        type="button"
                        onClick={() => void send(c)}
                        disabled={busyId === c.id}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
                      >
                        Send now
                      </button>
                    ) : null}
                    {!isTerminal(c.status) ? (
                      <button
                        type="button"
                        onClick={() => void testSend(c)}
                        disabled={busyId === c.id}
                        className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        Test send
                      </button>
                    ) : null}
                    {!isTerminal(c.status) ? (
                      <button
                        type="button"
                        onClick={() => setScheduleId(scheduleId === c.id ? null : c.id)}
                        disabled={busyId === c.id}
                        className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        {c.scheduledAt ? "Reschedule" : "Schedule"}
                      </button>
                    ) : null}
                    {isEditable(c.status) ? (
                      <button
                        type="button"
                        onClick={() => setEditingId(c.id)}
                        disabled={busyId === c.id}
                        className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        Edit
                      </button>
                    ) : null}
                    {c.status === "draft" || c.status === "scheduled" ? (
                      <button
                        type="button"
                        onClick={() => void cancel(c)}
                        disabled={busyId === c.id}
                        className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    ) : null}
                    {c.status === "draft" || c.status === "cancelled" ? (
                      <button
                        type="button"
                        onClick={() => void remove(c)}
                        disabled={busyId === c.id}
                        className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive disabled:opacity-60"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>

                {scheduleId === c.id ? (
                  <SchedulePanel
                    campaign={c}
                    onScheduled={() => {
                      setScheduleId(null);
                      void mutate();
                    }}
                    onCancel={() => setScheduleId(null)}
                  />
                ) : null}

                {c.status === "sent" ? <MetricsRow id={c.id} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
