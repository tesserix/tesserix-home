// `@tesserix/web`'s barrel is itself "use client" — its exports resolve to
// `undefined` inside a server component and React fails at render with
// "Element type is invalid". This module also holds state, so the directive is
// doubly required. See `components/kit/page-header.tsx`.
"use client";

import { useState, useTransition } from "react";
import { Button, Callout, CalloutDescription, CalloutTitle } from "@tesserix/web";
import { AlertTriangle, Info, Send } from "lucide-react";

import {
  DRAFT_DOES_NOT_SEND,
  TEST_SEND_IS_REAL,
  UNAUTHORED_OPENS_THE_DEFAULT,
  savedCopy,
  sendingNow,
  type EmailTemplateDetail,
} from "@/lib/email-templates";
import {
  saveEmailTemplateAction,
  testSendEmailTemplateAction,
} from "../actions";

export interface TemplateEditorProps {
  detail: EmailTemplateDetail;
  /** Whether the operator holds `mass-send`. UX only — the action re-checks. */
  canSend: boolean;
}

type Status = "draft" | "published";

/**
 * The editor for one mark8ly template.
 *
 * # What it opens with, and why that needs saying
 *
 * For an UNAUTHORED key the bodies below are mark8ly's embedded default — what
 * is sending right now — not anything an operator wrote. Presenting them as
 * authored copy would make Save look like a no-op when it is the act that
 * creates an override, so the banner says so.
 *
 * # The status control carries a consequence, not a label
 *
 * Nothing about the word "draft" implies that the previous copy keeps going
 * out. mark8ly's send path filters on `status = 'published'`, so a correction
 * saved as a draft changes nothing a customer sees. That is said HERE, beside
 * the radio, at the moment the choice is made — a legend at the top of the page
 * is not where someone about to click Save is looking.
 */
export function TemplateEditor({ detail, canSend }: TemplateEditorProps) {
  const [subject, setSubject] = useState(detail.subject);
  const [html, setHtml] = useState(detail.html_body);
  const [text, setText] = useState(detail.text_body);
  // Defaults to what the row already is, EXCEPT for an unauthored key, where
  // there is no stored status to preserve. `draft` is the safe default there:
  // publishing is what changes what customers receive, and a first save should
  // not do that because a select happened to be pre-set.
  const [status, setStatus] = useState<Status>(
    detail.state === "published" ? "published" : "draft",
  );
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pending, start] = useTransition();

  const live = sendingNow(detail);
  const stored = savedCopy(detail);

  function save() {
    start(async () => {
      setSaveMessage(null);
      const result = await saveEmailTemplateAction(detail.id, {
        subject,
        html_body: html,
        text_body: text,
        // Carried back unchanged. The declared interpolations belong to
        // mark8ly's Go call site; a console that edited them would be authoring
        // a contract it does not own, and mark8ly would keep rendering the ones
        // its code actually passes.
        variables: detail.variables,
        status,
      });
      setSaveFailed(!result.ok);
      setSaveMessage(
        result.ok
          ? status === "published"
            ? "Published. This is now the copy mark8ly sends."
            : "Saved as a draft. Nothing customers receive has changed."
          : result.message,
      );
    });
  }

  return (
    <div className="space-y-6">
      {/* WHAT IS SENDING, AND WHAT IS STORED — two answers, side by side, for
          the reason the list's two columns exist. `state` and `sends_from` are
          orthogonal, and a draft row and a never-edited row both send the
          embedded default for different reasons. */}
      <section className="grid gap-4 rounded border p-4 sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Sending now</p>
          <p className="font-medium">{live.label}</p>
          <p className="mt-1 text-sm text-muted-foreground">{live.detail}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Stored here</p>
          <p className="font-medium">{stored.label}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {stored.detail}
            {detail.version !== undefined ? ` Version ${detail.version}.` : ""}
          </p>
        </div>
      </section>

      {detail.state === "unauthored" ? (
        <Callout variant="info" role="note">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CalloutTitle>This is mark8ly&apos;s built-in copy</CalloutTitle>
              <CalloutDescription>{UNAUTHORED_OPENS_THE_DEFAULT}</CalloutDescription>
            </div>
          </div>
        </Callout>
      ) : null}

      <section className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="template-subject">
          Subject
        </label>
        <input
          id="template-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          className="w-full rounded border px-2 py-1 font-mono text-sm"
        />

        <label className="block text-sm font-medium" htmlFor="template-html">
          HTML body
        </label>
        <textarea
          id="template-html"
          value={html}
          onChange={(event) => setHtml(event.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded border px-2 py-1 font-mono text-sm"
        />

        <label className="block text-sm font-medium" htmlFor="template-text">
          Plain-text body
        </label>
        <textarea
          id="template-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full rounded border px-2 py-1 font-mono text-sm"
        />

        <Variables variables={detail.variables} />

        <Preview templateKey={detail.key} html={html} text={text} />
      </section>

      <section className="space-y-3 rounded border p-4">
        <fieldset>
          <legend className="text-sm font-medium">On save</legend>
          <div className="mt-2 space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="status"
                value="published"
                checked={status === "published"}
                onChange={() => setStatus("published")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Publish</span>
                <span className="block text-muted-foreground">
                  Customers start receiving this copy.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="status"
                value="draft"
                checked={status === "draft"}
                onChange={() => setStatus("draft")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Save as a draft</span>
                <span className="block text-muted-foreground">{DRAFT_DOES_NOT_SEND}</span>
              </span>
            </label>
          </div>
        </fieldset>

        {/* Repeated as a warning when draft is actually selected. The line
            under the radio is what an operator reads while choosing; this is
            what sits beside the button they are about to press. */}
        {status === "draft" ? (
          <Callout variant="warning" role="status">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <CalloutTitle>A draft does not send</CalloutTitle>
                <CalloutDescription>
                  {DRAFT_DOES_NOT_SEND} Right now that is: {live.label.toLowerCase()}.
                </CalloutDescription>
              </div>
            </div>
          </Callout>
        ) : null}

        <Button type="button" onClick={save} disabled={pending}>
          {status === "published" ? "Save and publish" : "Save draft"}
        </Button>

        {saveMessage ? (
          <p
            role={saveFailed ? "alert" : "status"}
            className={saveFailed ? "text-sm text-destructive" : "text-sm"}
          >
            {saveMessage}
          </p>
        ) : null}
      </section>

      <TestSend id={detail.id} canSend={canSend} />
    </div>
  );
}

/**
 * The bodies as written, rendered.
 *
 * # It is RAW, and the label says so
 *
 * `{{.OrderNumber}}` appears literally, because interpolating it here would
 * mean reimplementing Go's `html/template` in JavaScript. The two would agree
 * on the easy cases and disagree on exactly the ones a preview earns its keep
 * for — conditionals, ranges, a missing key — and an operator cannot tell a
 * confident wrong preview from a right one. Rendering truthfully needs the
 * product to render it; that is the remaining half of #587.
 *
 * So this answers "is my markup right, does the layout hold" and does not
 * pretend to answer "what does the merchant receive". The heading says which.
 *
 * # Why an iframe, and why the sandbox is empty
 *
 * The body is operator-authored HTML and can contain anything a template
 * author typed. Rendering it inline would let it inherit console styling,
 * escape its box, and run script in the console's own origin against a live
 * operator session.
 *
 * `srcDoc` rather than a blob URL keeps it synchronous with the textarea, so
 * the preview tracks typing with no lifecycle to leak.
 */
function Preview({
  templateKey,
  html,
  text,
}: {
  templateKey: string;
  html: string;
  text: string;
}) {
  const [mode, setMode] = useState<"html" | "text">("html");

  return (
    <div className="rounded border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <span className="text-sm font-medium">Preview</span>{" "}
          <span className="text-xs text-muted-foreground">
            raw — variables are not filled in
          </span>
        </div>
        <div className="flex gap-1" role="group" aria-label="Preview format">
          {(["html", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={
                mode === m
                  ? "rounded bg-foreground px-2 py-0.5 text-xs uppercase text-background"
                  : "rounded px-2 py-0.5 text-xs uppercase text-muted-foreground"
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === "html" ? (
        <iframe
          // The EMPTY string is deliberate and is the most restrictive value:
          // it grants no capability at all. Do not "fix" it to
          // allow-same-origin — that hands operator-authored HTML the
          // console's own origin.
          sandbox=""
          srcDoc={html}
          title={`${templateKey} preview`}
          className="h-[420px] w-full rounded-b bg-white"
        />
      ) : (
        <pre className="m-0 max-h-[420px] overflow-auto rounded-b p-3 text-xs">{text}</pre>
      )}
    </div>
  );
}

function Variables({ variables }: { variables: EmailTemplateDetail["variables"] }) {
  if (variables.length === 0) {
    // Never nil on the wire, but empty is ordinary — plenty of templates
    // interpolate nothing. Said rather than rendered as a blank area, which
    // reads as a list that failed to load.
    return (
      <p className="text-sm text-muted-foreground">
        This template declares no variables.
      </p>
    );
  }
  return (
    <div className="text-sm">
      <p className="font-medium">Variables mark8ly passes to this template</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {variables.map((variable) => (
          <li key={variable.name}>
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {`{{.${variable.name}}}`}
            </code>{" "}
            {variable.type}
            {variable.required ? " · required" : " · optional"}
          </li>
        ))}
      </ul>
      {/* The list is the product's, not this page's: mark8ly's Go call site
          decides which values it passes, so the console shows them and does
          not offer to change them. A subject or body interpolating anything
          else renders empty. */}
      <p className="mt-1 text-xs text-muted-foreground">
        Declared by mark8ly&apos;s code. Anything else you interpolate renders empty.
      </p>
    </div>
  );
}

/**
 * The test send.
 *
 * A REAL email through mark8ly's production provider, which is why the panel
 * says so before the field rather than after the button. It also renders
 * whatever is LIVE for this key — not the unsaved text above — so an operator
 * testing a fix they have not published receives the old mail; that is stated
 * too, because reading it as "the fix failed" is the obvious mistake.
 *
 * `mass-send`, separately from the rest of the editor. Hidden without it, and
 * `testSendEmailTemplateAction` asserts it against the live gate regardless:
 * a hidden control is UX, not authorization.
 */
function TestSend({ id, canSend }: { id: string; canSend: boolean }) {
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  if (!canSend) {
    return (
      <section className="rounded border border-dashed p-4 text-sm text-muted-foreground">
        Test sending needs the mass-send permission, which this account does not
        hold. Editing a template and sending one are separate permissions.
      </section>
    );
  }

  function send() {
    start(async () => {
      setMessage(null);
      const result = await testSendEmailTemplateAction(id, to);
      setFailed(!result.ok);
      setMessage(result.ok ? `Sent a real email to ${to.trim()}.` : result.message);
    });
  }

  return (
    <section className="space-y-3 rounded border border-destructive/40 p-4">
      <h2 className="flex items-center gap-2 font-medium">
        <Send className="h-4 w-4" aria-hidden="true" />
        Send a real test email
      </h2>
      <p className="text-sm text-muted-foreground">{TEST_SEND_IS_REAL}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="test-send-to">
          Recipient address
        </label>
        <input
          id="test-send-to"
          type="email"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="ops@tesserix.app"
          className="rounded border px-2 py-1 text-sm"
        />
        <Button
          type="button"
          variant="destructive"
          onClick={send}
          // Disabled until an address is typed: the destructive styling says
          // this is irrevocable, and an enabled button with an empty field
          // invites the click that finds out.
          disabled={pending || to.trim().length === 0}
        >
          Send real email
        </Button>
      </div>

      {message ? (
        <p role={failed ? "alert" : "status"} className={failed ? "text-sm text-destructive" : "text-sm"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
