"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";

type TemplateStatus = "published" | "draft";

interface TemplateVariable {
  name: string;
  type: string;
  required: boolean;
}

interface Template {
  database: "platform_api" | "marketplace_api";
  key: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  variables: TemplateVariable[];
  status: TemplateStatus;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

const STATUS_TONE: Record<TemplateStatus, string> = {
  published: "bg-emerald-50 text-emerald-700",
  draft: "bg-amber-50 text-amber-700",
};

export default function TemplateEditPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = use(params);
  const searchParams = useSearchParams();
  const database =
    (searchParams.get("database") as "platform_api" | "marketplace_api") ??
    "platform_api";

  const [template, setTemplate] = useState<Template | null>(null);
  const [subject, setSubject] = useState("");
  const [htmlBody, setHtmlBody] = useState("");
  const [textBody, setTextBody] = useState("");
  const [status, setStatus] = useState<TemplateStatus>("published");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"html" | "text">("html");
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/email-templates/${encodeURIComponent(key)}?database=${database}`, {
      credentials: "include",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((t: Template) => {
        if (cancelled) return;
        setTemplate(t);
        setSubject(t.subject);
        setHtmlBody(t.htmlBody);
        setTextBody(t.textBody);
        setStatus(t.status);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, database]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(
        `/api/admin/email-templates/${encodeURIComponent(key)}?database=${database}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject,
            htmlBody,
            textBody,
            variables: template?.variables ?? [],
            status,
          }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${res.status}`);
      }
      const updated: Template = await res.json();
      setTemplate(updated);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      // Build synthetic vars from declared variables — fill with the
      // variable name as the placeholder value. Operator can override
      // by editing the test recipient or using a more elaborate
      // sample-vars surface in a future iteration.
      const vars: Record<string, string> = {};
      for (const v of template?.variables ?? []) {
        vars[v.name] = `sample-${v.name}`;
      }
      const res = await fetch(
        `/api/admin/email-templates/${encodeURIComponent(key)}/test-send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ to: testTo, vars }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        sent?: boolean;
        to?: string;
        message?: string;
      };
      if (!res.ok) {
        setTestResult(`Send failed: ${body.message ?? `HTTP ${res.status}`}`);
      } else {
        setTestResult(`Sent to ${body.to ?? testTo} ✓`);
      }
    } catch (e) {
      setTestResult(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title={`Edit · ${key}`}
        description={`${database} · template authoring (mark8ly DB cross-write)`}
      />
      <div className="flex-1 space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Link
            href="/admin/notifications/templates"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← All templates
          </Link>
          {template && (
            <span className="text-xs text-muted-foreground">
              v{template.version} · last updated{" "}
              {new Date(template.updatedAt).toLocaleString()}
              {template.updatedBy ? ` by ${template.updatedBy}` : ""}
            </span>
          )}
        </div>

        {loading && (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {error && !loading && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            {error}
          </div>
        )}

        {template && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Editor */}
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Subject (Go template)
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  HTML body
                </label>
                <textarea
                  value={htmlBody}
                  onChange={(e) => setHtmlBody(e.target.value)}
                  rows={20}
                  spellCheck={false}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Text body
                </label>
                <textarea
                  value={textBody}
                  onChange={(e) => setTextBody(e.target.value)}
                  rows={10}
                  spellCheck={false}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </span>
                  <button
                    onClick={() => setStatus("published")}
                    aria-pressed={status === "published"}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
                      status === "published"
                        ? STATUS_TONE.published
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    Published
                  </button>
                  <button
                    onClick={() => setStatus("draft")}
                    aria-pressed={status === "draft"}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
                      status === "draft"
                        ? STATUS_TONE.draft
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    Draft
                  </button>
                </div>
                <Button onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
              {savedAt && (
                <p className="text-xs text-emerald-700">Saved at {savedAt}</p>
              )}
            </div>

            {/* Preview + variables + test send */}
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Preview (raw, no var interpolation)
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setPreviewMode("html")}
                      aria-pressed={previewMode === "html"}
                      className={`rounded px-2 py-0.5 text-[10px] uppercase ${
                        previewMode === "html"
                          ? "bg-foreground text-background"
                          : "text-muted-foreground"
                      }`}
                    >
                      HTML
                    </button>
                    <button
                      onClick={() => setPreviewMode("text")}
                      aria-pressed={previewMode === "text"}
                      className={`rounded px-2 py-0.5 text-[10px] uppercase ${
                        previewMode === "text"
                          ? "bg-foreground text-background"
                          : "text-muted-foreground"
                      }`}
                    >
                      Text
                    </button>
                  </div>
                </div>
                {previewMode === "html" ? (
                  <iframe
                    srcDoc={htmlBody}
                    sandbox=""
                    className="h-[420px] w-full rounded-b-lg bg-white"
                    title={`${key} preview`}
                  />
                ) : (
                  <pre className="m-0 max-h-[420px] overflow-auto rounded-b-lg bg-muted/40 p-3 text-xs">
                    {textBody}
                  </pre>
                )}
              </div>

              <div className="rounded-lg border border-border bg-card p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Variables
                </p>
                {template.variables.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No declared variables.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {template.variables.map((v) => (
                      <li key={v.name} className="flex items-center gap-2">
                        <span className="font-mono">{v.name}</span>
                        <span className="text-muted-foreground">{v.type}</span>
                        {v.required && (
                          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-700">
                            required
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-lg border border-border bg-card p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Send test (real SendGrid → recipient inbox)
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="email"
                    placeholder="leave blank for your own email"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                  <Button onClick={sendTest} disabled={testing} variant="outline">
                    {testing ? "Sending…" : "Send test"}
                  </Button>
                </div>
                {testResult && (
                  <p className="mt-2 text-xs text-muted-foreground">{testResult}</p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Sample variables (synthesized as <code>sample-&lt;name&gt;</code>)
                  are passed to mark8ly&apos;s render endpoint. The send goes through
                  the same SendGrid pipeline a production send would use.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
