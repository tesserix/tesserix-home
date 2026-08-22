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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";
import type { DirectoryGroup, DirectoryTool } from "@/lib/tools-directory";
import type { ToolInput, ToolsWriteResult } from "@/lib/tools-write";

/**
 * The add/edit form for one directory tool, as a self-contained trigger +
 * dialog — the same shape as `OrganisationEditForm`
 * (`app/(console)/platform/crm/[organisation]/organisation-edit-form.tsx`).
 *
 * One component serves both modes because the fields, the validation and the
 * error placement are identical; only the starting values, the dialog copy
 * and which action gets called differ, and all three are supplied by the
 * caller.
 *
 * Field errors use `Input`'s own `isInvalid`/`errorText` props — the same
 * pattern `organisation-edit-form.tsx` uses — rather than a hand-rolled
 * wrapper: `Input` already wires `aria-invalid` and `aria-describedby` onto
 * the input itself so the association survives a screen-reader user tabbing
 * away and back, which a bespoke `<p>` placed only visually beside the input
 * would not.
 *
 * `import type` for everything from `lib/tools-directory` and
 * `lib/tools-write` — both open with `import "server-only"` and this is a
 * client component. tsc cannot catch a value import of either; only the
 * bundler can, which is why the build is required for this task.
 */
export function ToolForm({
  mode,
  groups,
  tool,
  defaultGroupKey,
  triggerLabel,
  onSubmit,
}: {
  mode: "add" | "edit";
  groups: readonly DirectoryGroup[];
  /** Required in edit mode, for the starting values and the dialog title. */
  tool?: DirectoryTool;
  /** Add mode only: which group the new tool's select should preselect. */
  defaultGroupKey?: string;
  triggerLabel: string;
  onSubmit: (input: ToolInput) => Promise<ToolsWriteResult>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(tool?.name ?? "");
  const [subdomain, setSubdomain] = useState(tool?.subdomain ?? "");
  const [purpose, setPurpose] = useState(tool?.purpose ?? "");
  const [note, setNote] = useState(tool?.note ?? "");
  const [groupKey, setGroupKey] = useState(tool?.groupKey ?? defaultGroupKey ?? groups[0]?.key ?? "");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [pending, setPending] = useState(false);

  // Re-seed from the starting values rather than keeping whatever the last,
  // possibly abandoned, edit left behind.
  const reset = () => {
    setName(tool?.name ?? "");
    setSubdomain(tool?.subdomain ?? "");
    setPurpose(tool?.purpose ?? "");
    setNote(tool?.note ?? "");
    setGroupKey(tool?.groupKey ?? defaultGroupKey ?? groups[0]?.key ?? "");
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
    const result = await onSubmit({
      name,
      subdomain,
      purpose,
      // An empty note is "no note", not the three-character string "" — the
      // seam's `null` and an empty string are different answers to "does
      // this tool have a note", and only `null` is the correct one here.
      note: note.trim() === "" ? null : note,
      groupKey,
    });
    setPending(false);
    if (!result.ok) {
      setError({ message: result.message, field: result.field });
      return;
    }
    setOpen(false);
    reset();
  };

  const formId = `tool-form-${mode}-${tool?.id ?? "new"}`;
  const title = mode === "add" ? "Add tool" : `Edit ${tool?.name ?? "tool"}`;
  const description =
    mode === "add"
      ? "Add a tool to the internal tools directory."
      : "Update this tool's details in the directory.";

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
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
            // `required` below still marks the fields for assistive tech, but
            // native validation is not the check that matters here — the
            // API's 422 is the authority (see the module doc). This keeps a
            // native bubble from firing first and hiding that message.
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                value={name}
                disabled={pending}
                required
                isInvalid={Boolean(fieldError("name"))}
                errorText={fieldError("name")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            {/* No pattern validation here: the DNS-label rule already lives
                in Go's domain.SubdomainPattern and the SQL CHECK, bound by a
                test. A third copy in TypeScript would need its own drift
                test and would rot. The API's 422 is the authority. */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-subdomain`}>Subdomain</Label>
              <Input
                id={`${formId}-subdomain`}
                value={subdomain}
                disabled={pending}
                required
                isInvalid={Boolean(fieldError("subdomain"))}
                errorText={fieldError("subdomain")}
                onChange={(event) => setSubdomain(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-purpose`}>Purpose</Label>
              <Input
                id={`${formId}-purpose`}
                value={purpose}
                disabled={pending}
                required
                isInvalid={Boolean(fieldError("purpose"))}
                errorText={fieldError("purpose")}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-note`}>Note (optional)</Label>
              <Input
                id={`${formId}-note`}
                value={note}
                disabled={pending}
                isInvalid={Boolean(fieldError("note"))}
                errorText={fieldError("note")}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-group`}>Group</Label>
              {/* No `name`: this form submits from React state via `onSubmit`,
                  never through `FormData`, so the hidden native select Radix
                  mirrors its value onto would never be read. */}
              <Select value={groupKey} onValueChange={setGroupKey} disabled={pending}>
                <SelectTrigger id={`${formId}-group`} size="default">
                  <SelectValue placeholder="Choose a group…" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.key} value={group.key}>
                      {group.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
