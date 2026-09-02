"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@tesserix/web";
import type { ContactRow } from "@/lib/db/crm-repo";
import type { TemplateRow } from "@/lib/db/crm-templates";
import { copyAndLogDm, previewTemplate } from "./actions";
import { ErrorNote } from "./error-note";

/**
 * Send a templated DM to one lead: pick a template, pick a contact, read the
 * rendered message, copy it, and log that it went (#LDQ).
 *
 * ITS OWN FILE. `organisation-detail-view.tsx` is past 770 lines and
 * `activity-composer.tsx` already set the precedent for a composer that owns
 * its own state machine rather than living as a function inside the view.
 *
 * ══ WHAT THIS COMPONENT NEVER RECEIVES ══
 *
 * `contacts` here is `crm-repo.ts`'s `ContactRow`, which has NO `biography`.
 * The renderer's `TemplateContactRow` does, and passing that shape down would
 * serialise a scraped bio into the RSC payload for every contact on the page —
 * whether or not the operator ever opens this composer. The bio reaches the
 * browser exactly once: inside the rendered text of a template the operator
 * deliberately previewed. That narrowing is the whole reason `crm-templates.ts`
 * declares a separate contact shape.
 *
 * ══ WHAT THE PREVIEW REFUSAL DOES HERE ══
 *
 * The textarea stays EMPTY on any refusal and the copy control is `disabled`.
 * Never seeded with a partial render, never seeded with "the bit that worked":
 * `renderTemplate` returns no text at all when a field is missing, and this
 * component's job is to carry that contract to the screen intact rather than
 * soften it into a warning the operator can click past.
 */

/** What the composer knows about the preview right now. `idle` is the state
 *  before both selections exist; it is distinct from `refused` so the copy
 *  control's disabled-ness never implies a problem that has not occurred. */
type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "refused"; message: string };

function contactLabel(contact: ContactRow): string {
  return (
    contact.instagramHandle ??
    contact.name ??
    contact.email ??
    "Contact with no name on file"
  );
}

export function TemplateComposer({
  organisationId,
  templates,
  contacts,
}: {
  organisationId: string;
  /** Live `dm` templates only — `page.tsx` asks for exactly those. An email
   *  template logged as a DM would put a claim in the outreach log the
   *  operator never made, which `recordTemplatedDm` also refuses server-side. */
  templates: readonly TemplateRow[];
  contacts: readonly ContactRow[];
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(
    contacts.length === 1 ? contacts[0].id : null,
  );
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [logged, setLogged] = useState(false);

  // The preview is a READ with no audit row (see `previewTemplate`), so
  // running it on every selection change costs nothing an operator pays for.
  //
  // `ignore` is not ceremony: an operator flicking through templates fires
  // several of these, and without it a slow earlier response can land after a
  // faster later one and seed the textarea with a message for a template that
  // is no longer selected — the operator would then copy text they cannot see
  // the source of.
  useEffect(() => {
    if (!templateId || !contactId) {
      setPreview({ status: "idle" });
      setText("");
      return;
    }
    let ignore = false;
    setPreview({ status: "loading" });
    setError(null);
    setLogged(false);
    void previewTemplate({ organisationId, contactId, templateId }).then((result) => {
      if (ignore) return;
      if (!result.ok) {
        setPreview({ status: "refused", message: result.message });
        // Emptied, not left holding the previous template's message. A stale
        // body under a fresh refusal is the one state where the operator could
        // copy a message for the wrong lead.
        setText("");
        return;
      }
      setPreview({ status: "ready", text: result.text });
      setText(result.text);
    });
    return () => {
      ignore = true;
    };
  }, [organisationId, templateId, contactId]);

  const canCopy = preview.status === "ready" && text.trim().length > 0 && !pending;

  /**
   * THE CLIPBOARD WRITE HAPPENS FIRST, SYNCHRONOUSLY, BEFORE ANY `await`.
   *
   * The Clipboard API requires transient user activation, and that activation
   * is consumed by the first `await` in a handler. Calling the server first and
   * writing afterwards works in Chrome and is REJECTED by Safari — leaving the
   * operator with a logged `dm_sent` activity, a lead moved to `contacted`, and
   * an empty clipboard. That is the worst of the three possible outcomes,
   * because the CRM then asserts a DM was sent that the operator never even had
   * the text of, and nothing on the screen contradicts it.
   *
   * So: copy, then log. The reverse failure — copied but not logged — is
   * recoverable and is what the error message below tells the operator to
   * expect, because they still hold the text and can decide whether to send it.
   */
  const copyAndLog = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (preview.status !== "ready" || !templateId || !contactId) return;

    const submittedText = text;
    setError(null);
    setLogged(false);

    // No `await` above this line. Deliberately not awaited at all: the promise
    // is handled for its rejection only, so the activation-consuming
    // continuation never runs before `writeText` has been called.
    const copying = navigator.clipboard
      .writeText(submittedText)
      .then(() => true)
      .catch(() => false);

    startTransition(async () => {
      const copied = await copying;
      const result = await copyAndLogDm({
        organisationId,
        contactId,
        templateId,
        submittedText,
      });
      if (!result.ok) {
        // Which half failed is the only thing the operator needs, and it is
        // the thing a generic error would hide. They still hold the message,
        // so the recoverable action is to log it — not to re-copy it, and
        // certainly not to send it twice.
        setError(
          copied
            ? `${result.message} The message WAS copied to your clipboard and was NOT logged.`
            : `${result.message} Nothing was copied and nothing was logged.`,
        );
        return;
      }
      if (!copied) {
        // Logged but not copied: the opposite half, and the more dangerous
        // one, so it is stated rather than swallowed. The activity is real —
        // undoing it is not this control's job — but the operator must know
        // the text is not on their clipboard before they go looking for it.
        setError(
          "Logged as sent, but the message could not be copied to your clipboard. Copy it from the box above before sending.",
        );
      }
      setLogged(true);
      router.refresh();
    });
  };

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No DM templates yet. Author one under CRM → Templates.
      </p>
    );
  }

  return (
    <section
      aria-labelledby="template-composer-heading"
      className="flex flex-col gap-3 border-b border-border pb-4"
    >
      <h3 id="template-composer-heading" className="text-sm font-medium">
        Send a templated DM
      </h3>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="dm-template">Template</Label>
          <Select
            value={templateId ?? undefined}
            onValueChange={setTemplateId}
            disabled={pending}
          >
            <SelectTrigger id="dm-template" size="sm" className="mt-1 w-56">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="dm-contact">Contact</Label>
          <Select
            value={contactId ?? undefined}
            onValueChange={setContactId}
            disabled={pending || contacts.length === 0}
          >
            <SelectTrigger id="dm-contact" size="sm" className="mt-1 w-56">
              <SelectValue placeholder="Choose a contact" />
            </SelectTrigger>
            <SelectContent>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contactLabel(contact)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Label htmlFor="dm-body">Message</Label>
      <Textarea
        id="dm-body"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        // Editable, and edits are kept: the per-lead rewrite IS the feature, not
        // a v1 limitation — identical text at volume is what draws Instagram's
        // enforcement. `copyAndLogDm` re-renders server-side to tell an edit
        // from a verbatim send, so nothing here has to be trusted about it.
        placeholder={
          preview.status === "idle"
            ? "Choose a template and a contact."
            : "Nothing to send yet."
        }
        disabled={pending || preview.status !== "ready"}
      />

      {/* Announced, not focused — the same choice `FollowUpPrompt` makes. The
          refusal appears in response to a selection the operator just made, so
          silence would leave a screen-reader user with a disabled button and no
          reason for it; stealing focus would interrupt someone already moving
          on to the next template. */}
      <div aria-live="polite" className="flex flex-col gap-1">
        {preview.status === "refused" ? (
          <p className="text-sm text-muted-foreground">{preview.message}</p>
        ) : null}
        {logged && !error ? (
          <p className="text-sm text-muted-foreground">Copied, and logged as sent.</p>
        ) : null}
      </div>

      <ErrorNote message={error} />

      <div>
        <Button type="button" size="sm" disabled={!canCopy} onClick={copyAndLog}>
          {pending ? "Logging…" : "Copy & log DM sent"}
        </Button>
      </div>
    </section>
  );
}
