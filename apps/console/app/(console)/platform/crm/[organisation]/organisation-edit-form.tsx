"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@tesserix/web";
import { UNSAFE_WEBSITE_URL_MESSAGE } from "@/lib/db/crm-url";
import type { OrganisationRow } from "@/lib/db/crm-repo";
import { updateOrganisationAction } from "./actions";

const BLANK_NAME_MESSAGE = "Enter an organisation name.";

/**
 * One of `category`/`tags`: a chip editor over a list of short strings.
 *
 * The values are submitted as one hidden field per entry because
 * `updateOrganisationAction` reads them with `formData.getAll(key)`. A
 * single comma-joined input would be stored as one literal value containing
 * commas — the row would still round-trip through the form and look right,
 * which is what makes that mistake worth ruling out here in markup rather
 * than catching downstream.
 */
function ValueListField({
  id,
  name,
  label,
  noun,
  hint,
  values,
  draft,
  disabled,
  onDraftChange,
  onAdd,
  onRemove,
}: {
  id: string;
  name: string;
  label: string;
  noun: string;
  hint: string;
  values: readonly string[];
  draft: string;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
}) {
  const commitDraft = () => {
    const value = draft.trim();
    if (value) onAdd(value);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {values.length > 0 ? (
        <ul aria-label={`${noun} values`} className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <li key={`${value}-${index}`}>
              <Badge variant="secondary" className="gap-1">
                {value}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${noun} ${value}`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  onClick={() => onRemove(index)}
                >
                  &times;
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {values.map((value, index) => (
        <input key={`${name}-${index}`} type="hidden" name={name} value={value} readOnly />
      ))}
      {/* Deliberately unnamed: this input carries the half-typed draft, and
          only the committed chips above submit. A draft becomes a chip via
          Enter, comma, or blur — never by being submitted from here. */}
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onDraftChange(event.target.value)}
        // Reaching Save blurs this input, so a value typed but never
        // committed with Enter still becomes an entry rather than being
        // silently dropped from a save that replaces the whole list.
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commitDraft();
          }
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/**
 * Correct an organisation's own fields (#227) — the repair path for a typo
 * and for the `category`/`tags` only the CSV import can set today.
 *
 * Lives beside `DeleteOrganisationButton` in `page.tsx`'s `actions` slot,
 * and in its own file: `organisation-detail-view.tsx` is already past this
 * repo's 800-line ceiling.
 *
 * Every editable field is submitted on every save, pre-filled from the
 * current row, because `updateOrganisation` is a full replacement of the
 * five and not a patch — an omitted field is cleared, not left alone.
 * `location` and `websiteUrl` are uncontrolled with a `defaultValue` for
 * exactly that reason: an untouched input is still in the `FormData`.
 */
export function OrganisationEditForm({ organisation }: { organisation: OrganisationRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(organisation.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [category, setCategory] = useState<readonly string[]>(organisation.category);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [tags, setTags] = useState<readonly string[]>(organisation.tags);
  const [tagsDraft, setTagsDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Re-seed from the row rather than keeping whatever the last, possibly
  // abandoned, edit left behind. `DialogContent` unmounts on close, so the
  // uncontrolled inputs re-seed themselves.
  const reset = () => {
    setName(organisation.name);
    setNameError(null);
    setCategory(organisation.category);
    setCategoryDraft("");
    setTags(organisation.tags);
    setTagsDraft("");
    setError(null);
  };

  const submit = (formData: FormData) => {
    if (!name.trim()) {
      setNameError(BLANK_NAME_MESSAGE);
      return;
    }
    setNameError(null);
    setError(null);
    startTransition(async () => {
      const result = await updateOrganisationAction(organisation.id, formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const isWebsiteError = error === UNSAFE_WEBSITE_URL_MESSAGE;

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit organisation
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{`Edit ${organisation.name}`}</DialogTitle>
            <DialogDescription>
              Corrects this organisation&apos;s own details. Its contacts, opportunities and
              activity log are untouched, and the change is recorded on the timeline.
            </DialogDescription>
          </DialogHeader>

          <form
            id="organisation-edit-form"
            className="flex flex-col gap-4"
            // `required` below still marks the field for assistive tech, but
            // native validation is not the check that matters: a name of
            // nothing but spaces satisfies it and is still blank. `submit`
            // makes that call, and this keeps a native bubble from firing
            // first and hiding the message the field announces.
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit(new FormData(event.currentTarget));
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-name">Organisation name</Label>
              <Input
                id="edit-name"
                name="name"
                value={name}
                disabled={pending}
                isInvalid={Boolean(nameError)}
                errorText={nameError ?? undefined}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-location">Location</Label>
              <Input
                id="edit-location"
                name="location"
                defaultValue={organisation.location ?? ""}
                disabled={pending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-websiteUrl">Website</Label>
              <Input
                id="edit-websiteUrl"
                name="websiteUrl"
                type="url"
                placeholder="https://"
                defaultValue={organisation.websiteUrl ?? ""}
                disabled={pending}
                isInvalid={isWebsiteError}
                errorText={isWebsiteError ? error : undefined}
              />
            </div>

            <ValueListField
              id="edit-category"
              name="category"
              label="Category"
              noun="category"
              hint="Press Enter to add a category."
              values={category}
              draft={categoryDraft}
              disabled={pending}
              onDraftChange={setCategoryDraft}
              onAdd={(value) => {
                setCategory((current) => (current.includes(value) ? current : [...current, value]));
                setCategoryDraft("");
              }}
              onRemove={(index) => setCategory((current) => current.filter((_, i) => i !== index))}
            />

            <ValueListField
              id="edit-tags"
              name="tags"
              label="Tags"
              noun="tag"
              hint="Press Enter to add a tag."
              values={tags}
              draft={tagsDraft}
              disabled={pending}
              onDraftChange={setTagsDraft}
              onAdd={(value) => {
                setTags((current) => (current.includes(value) ? current : [...current, value]));
                setTagsDraft("");
              }}
              onRemove={(index) => setTags((current) => current.filter((_, i) => i !== index))}
            />

            {error && !isWebsiteError ? (
              <Callout role="alert" variant="destructive">
                <CalloutDescription>{error}</CalloutDescription>
              </Callout>
            ) : null}
          </form>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" form="organisation-edit-form" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
