"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@tesserix/web";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import { MERGE_FIELDS } from "@/lib/crm-merge-fields";
import type { TemplateChannel, TemplateRow } from "@/lib/db/crm-templates";
import { ErrorNote } from "../[organisation]/error-note";
import { archiveTemplateAction, createTemplateAction } from "./actions";

/**
 * Author and retire the CRM's outreach copy.
 *
 * `ErrorNote` is imported from the organisation detail folder rather than
 * copied: it is already shared between that view and its two composers, and a
 * fourth copy is how four refusals end up rendered four different ways. The
 * do-not-contact list still has its own private duplicate; this file does not
 * add a fifth.
 */

/** The `crm_template_channel` enum, spelled for the picker. Derived from
 *  nothing — `TemplateChannel` is a union, not a runtime value — so the two
 *  are pinned together by the `satisfies` below rather than by hope. */
const CHANNELS = [
  { value: "dm", label: "Instagram DM" },
  { value: "email", label: "Email" },
] as const satisfies ReadonlyArray<{ value: TemplateChannel; label: string }>;

/**
 * The six tokens, printed where the operator is typing.
 *
 * NOT optional decoration, and not a link to documentation. `parseMergeFields`
 * refuses any token outside this exact set, and `{{contact.instagram_handle}}`
 * is not a string anybody guesses — it is not `{{handle}}`, not `{{instagram}}`
 * and not `{{contact.handle}}`. Without this list the surface's only feedback
 * on a plausible-looking guess is a rejection AFTER the operator has finished
 * writing, which teaches them the shape of the allowlist one refusal at a
 * time.
 *
 * `MERGE_FIELDS` is read directly rather than re-listed here, because a
 * hand-copied list is a second source of truth that goes stale silently: it
 * would keep advertising a field the registry had dropped, and the operator
 * would meet the unknown-field error while following our own instructions.
 * The registry's `label` is already written as operator-facing English for the
 * preview's refusal message, so it reads correctly here too.
 */
function MergeFieldLegend() {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Merge fields
      </p>
      <dl className="mt-2 flex flex-col gap-1 text-sm sm:grid sm:grid-cols-[auto_1fr] sm:gap-x-4">
        {Object.entries(MERGE_FIELDS).map(([token, field]) => (
          <div key={token} className="contents">
            <dt className="font-mono text-xs">{`{{${token}}}`}</dt>
            <dd className="text-muted-foreground">{field.label}</dd>
          </div>
        ))}
      </dl>
      {/* The rule, stated where it can still change what the operator writes.
          A template referencing a field this lead has no value for renders
          NOTHING — it does not fall back to an empty string — so a bio placed
          in the opening line quietly makes the template unusable for most of a
          fresh scrape. That is a design decision about the copy, and it is
          cheaper to make while writing it than to discover in the composer. */}
      <p className="mt-2 text-sm text-muted-foreground">
        A lead missing any field you use here cannot be sent this template at
        all — nothing is substituted, and the composer refuses instead.
      </p>
    </div>
  );
}

function CreateTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<TemplateChannel>("dm");
  const [product, setProduct] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && body.trim().length > 0 && !pending;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createTemplateAction({
        name: name.trim(),
        channel,
        product: product.trim() || null,
        // Only ever sent for `email`. `crm_template_subject_is_email_only`
        // rejects a subject on a DM, and the operator cannot see the field
        // they would be rejected for — leaving a stale value here after a
        // channel switch would fail the write for a reason invisible on screen.
        subject: channel === "email" ? subject.trim() || null : null,
        body: body.trim(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setName("");
      setProduct("");
      setSubject("");
      setBody("");
      // `channel` is deliberately NOT reset: an operator writing templates is
      // almost always writing several for the same channel in one sitting, and
      // silently flipping back to DM after an email template is how an email
      // subject line goes missing on the next one.
      router.refresh();
    });
  };

  return (
    <form
      className="flex flex-col gap-4 border-t border-border pt-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2 className="text-sm font-medium">New template</h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            className="mt-1 h-9"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            placeholder="Bondi cafés — first touch"
          />
        </div>

        <div>
          <Label htmlFor="template-channel">Channel</Label>
          <Select
            value={channel}
            onValueChange={(value) => setChannel(value as TemplateChannel)}
            disabled={pending}
          >
            <SelectTrigger id="template-channel" size="sm" className="mt-1 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNELS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="template-product">Product</Label>
          <Input
            id="template-product"
            className="mt-1 h-9 w-44"
            value={product}
            disabled={pending}
            onChange={(event) => setProduct(event.target.value)}
            // Empty means ANY product, per 0043 — not "unknown". Said in the
            // placeholder because a blank field otherwise reads as unfinished.
            placeholder="Any product"
          />
        </div>
      </div>

      {/* Shown only for `email`, mirroring the CHECK rather than restating it:
          a subject on a DM is rejected by the database, and a field that can
          only ever produce a refusal is worse than no field. */}
      {channel === "email" ? (
        <div>
          <Label htmlFor="template-subject">Subject</Label>
          <Input
            id="template-subject"
            className="mt-1 h-9"
            value={subject}
            disabled={pending}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="A quick note about {{org.name}}"
          />
        </div>
      ) : null}

      <div>
        <Label htmlFor="template-body">Message</Label>
        <Textarea
          id="template-body"
          className="mt-1"
          value={body}
          rows={8}
          disabled={pending}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Hi {{contact.name}} — I came across {{org.name}} in {{org.location}}…"
        />
      </div>

      <MergeFieldLegend />

      <ErrorNote message={error} />

      <div>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {pending ? "Saving…" : "Save template"}
        </Button>
      </div>
    </form>
  );
}

function TemplateRowItem({ template }: { template: TemplateRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const archive = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveTemplateAction(template.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  const channelLabel =
    CHANNELS.find((option) => option.value === template.channel)?.label ?? template.channel;

  return (
    <li className="border-t border-border py-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{template.name}</div>
          <div className="mt-1 text-muted-foreground">
            {channelLabel} · {template.product ?? "Any product"} · added by{" "}
            {template.createdBy} on {new Date(template.createdAt).toLocaleDateString()}
          </div>
          {template.subject ? (
            <div className="mt-2 text-muted-foreground">Subject: {template.subject}</div>
          ) : null}
          {/* The body in full, wrapped, not truncated to a single line. An
              operator deciding whether to archive a template is deciding
              against its copy, and a one-line preview of a five-line DM hides
              the merge fields — the part that determines whether it renders
              for anyone at all. */}
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{template.body}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={archive}
        >
          {pending ? "Archiving…" : "Archive"}
        </Button>
      </div>
      <ErrorNote message={error} />
    </li>
  );
}

export function TemplatesView({
  templates,
  state,
  emptyMessage,
}: {
  templates: readonly TemplateRow[];
  state: SurfaceState;
  emptyMessage: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* The list first, the form under it — the reverse of the do-not-contact
          list. That surface's form is three short inputs an operator uses far
          more often than they read the list; this one is a body of copy they
          write occasionally, and the question they arrive with is almost
          always "what do we already say?". */}
      {state.kind === "ready" ? (
        <ul className="flex flex-col">
          {templates.map((template) => (
            <TemplateRowItem key={template.id} template={template} />
          ))}
        </ul>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} />
      )}
      <CreateTemplateForm />
    </div>
  );
}
