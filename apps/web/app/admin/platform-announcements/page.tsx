"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useToast } from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";

interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience_filter: Record<string, unknown>;
  starts_at: string;
  ends_at: string | null;
  is_published: boolean;
  created_at: string;
}

const fetcher = (u: string) => fetch(u, { credentials: "include" }).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

const SEVERITIES = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "maintenance", label: "Maintenance" },
  { value: "incident", label: "Incident" },
];

const SEVERITY_TONE: Record<string, string> = {
  info: "bg-sky-500/15 text-sky-700",
  warning: "bg-amber-500/15 text-amber-700",
  maintenance: "bg-violet-500/15 text-violet-700",
  incident: "bg-rose-500/15 text-rose-700",
};

export default function PlatformAnnouncementsPage() {
  const { data, mutate } = useSWR<{ rows: Announcement[] }>("/api/admin/platform-announcements", fetcher, { revalidateOnFocus: false });
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("info");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!title.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/platform-announcements", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, severity, isPublished: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Announcement saved (unpublished)" });
      setTitle(""); setBody("");
      await mutate();
    } catch {
      toast({ title: "Failed to save", description: "Check console" });
    } finally {
      setSubmitting(false);
    }
  }

  async function togglePublished(a: Announcement) {
    await fetch(`/api/admin/platform-announcements/${a.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublished: !a.is_published }),
    });
    toast({ title: a.is_published ? "Unpublished" : "Published" });
    await mutate();
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Platform announcements" />
      <div className="flex-1 space-y-6 p-6">
        <section className="space-y-3 rounded-lg border border-border bg-card p-5">
          <h2 className="text-base font-medium">New announcement</h2>
          <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Body — Markdown not yet supported, plain text only"
            className="min-h-32 w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="h-9 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={submit} disabled={submitting || !title.trim() || !body.trim()} size="sm">
              {submitting ? "Saving…" : "Save (unpublished)"}
            </Button>
            <p className="text-xs text-muted-foreground">Saved as draft. Publish from the list below when ready.</p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-medium">All announcements</h2>
          <div className="space-y-2">
            {(data?.rows ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No announcements yet.</p>
            ) : (
              data?.rows.map((a) => (
                <article key={a.id} className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_TONE[a.severity] ?? "bg-muted"}`}>{a.severity}</span>
                      <h3 className="text-sm font-medium">{a.title}</h3>
                      {a.is_published ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700">Published</span>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Draft</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{a.body}</p>
                    <p className="text-xs text-muted-foreground">Created {new Date(a.created_at).toLocaleString()}</p>
                  </div>
                  <Button size="sm" variant={a.is_published ? "outline" : "default"} onClick={() => togglePublished(a)}>
                    {a.is_published ? "Unpublish" : "Publish"}
                  </Button>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
