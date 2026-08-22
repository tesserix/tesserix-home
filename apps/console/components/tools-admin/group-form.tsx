"use client";

import { useState } from "react";
import {
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
import type { DirectoryGroup } from "@/lib/tools-directory";
import type { ToolsWriteResult } from "@/lib/tools-write";

// Mirrors `lib/tools-write.ts`'s own `NOT_SAVED` sentence — see `ToolForm`
// for why this cannot be imported and when this copy actually shows.
const NOT_SAVED = "That change was not saved. Try again shortly.";

/**
 * The add/rename form for one directory group, as a self-contained trigger +
 * dialog — the same shape `ToolForm` uses.
 *
 * The key field is add-mode only, and rendered nowhere at all in rename mode
 * — not disabled, not read-only, absent. The key is a foreign key every tool
 * in the group references; the API refuses to change it with a 400 that
 * explains the remedy, and a visible-but-inert field would only invite the
 * question of why it can't be touched.
 *
 * Field errors use `Input`'s own `isInvalid`/`errorText` props, same as
 * `ToolForm` — `Input` wires `aria-invalid`/`aria-describedby` onto the input
 * itself, so the association survives a screen-reader user tabbing away and
 * back.
 */
export function GroupForm({
  mode,
  group,
  triggerLabel,
  triggerAriaLabel,
  onSubmit,
}: {
  mode: "add" | "rename";
  /** Required in rename mode, for the starting value and the dialog title. */
  group?: DirectoryGroup;
  triggerLabel: string;
  /**
   * Overrides the trigger's accessible name without changing its visible
   * text — same reasoning as `ToolForm.triggerAriaLabel`: multiple groups
   * each render a "Rename" trigger with the same visible text, and a query
   * against that shared text has nothing to disambiguate them by. Passed as
   * e.g. `Rename ${group.label}`.
   */
  triggerAriaLabel?: string;
  onSubmit: (input: { key: string; label: string }) => Promise<ToolsWriteResult>;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(group?.key ?? "");
  const [label, setLabel] = useState(group?.label ?? "");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [pending, setPending] = useState(false);

  // Resets `key` too, even in rename mode where the field is never rendered
  // and `key`'s value is otherwise unused (the rename caller's `onSubmit`
  // reads only `input.label`, ignoring `input.key`). Harmless: one `reset`
  // shared by both modes is simpler than forking it by mode to skip a state
  // update nothing reads.
  const reset = () => {
    setKey(group?.key ?? "");
    setLabel(group?.label ?? "");
    setError(null);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const fieldError = (field: string): string | undefined =>
    error?.field === field ? error.message : undefined;
  const formError = error && !error.field ? error.message : null;

  const submit = async () => {
    setError(null);
    setPending(true);
    try {
      const result = await onSubmit({ key, label });
      if (!result.ok) {
        setError({ message: result.message, field: result.field });
        return;
      }
      setOpen(false);
      reset();
    } catch {
      // The action call itself rejected rather than resolving with a
      // ToolsWriteResult — see ToolForm's identical catch for the full
      // reasoning.
      setError({ message: NOT_SAVED });
    } finally {
      setPending(false);
    }
  };

  const formId = `group-form-${mode}-${group?.key ?? "new"}`;
  const title = mode === "add" ? "Add group" : `Rename ${group?.label ?? "group"}`;
  const description =
    mode === "add"
      ? "Add a group to the internal tools directory."
      : "Update this group's label.";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={triggerAriaLabel}
        onClick={() => {
          // Seed at OPEN time, not mount time — same reasoning as ToolForm:
          // `GroupHeader` is keyed on `group.key`, unchanged by a rename, so
          // this component is reconciled rather than remounted between opens.
          reset();
          setOpen(true);
        }}
      >
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <form
            id={formId}
            className="flex flex-col gap-4"
            // Native validation is not the authority here — the API's own
            // refusal is (see ToolForm for the same reasoning).
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === "add" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-key`}>Key</Label>
                <Input
                  id={`${formId}-key`}
                  value={key}
                  disabled={pending}
                  required
                  isInvalid={Boolean(fieldError("key"))}
                  errorText={fieldError("key")}
                  onChange={(event) => setKey(event.target.value)}
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-label`}>Label</Label>
              <Input
                id={`${formId}-label`}
                value={label}
                disabled={pending}
                required
                isInvalid={Boolean(fieldError("label"))}
                errorText={fieldError("label")}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>

            {formError ? (
              <Callout role="alert" variant="destructive">
                <CalloutDescription>{formError}</CalloutDescription>
              </Callout>
            ) : null}
          </form>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
