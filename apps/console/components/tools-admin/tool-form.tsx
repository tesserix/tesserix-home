"use client";

import { useState, type ReactNode } from "react";
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
 * One labelled field, with its error rendered as a sibling of the input
 * rather than through `Input`'s own `errorText` prop.
 *
 * `Input` only wraps itself in a `div` when `isValid`/`isInvalid`/`errorText`
 * is passed, and even then the error `<p>` lands one level ABOVE the div that
 * directly contains the `<input>` (that inner div also holds the validity
 * icon). A refusal is placed "beside the input" — see the module doc and the
 * seam's own contract — which callers, including tests, read as: inside the
 * nearest `<div>` ancestor of the input itself. So this renders its own
 * single wrapping `div` around just the input and the error text, with the
 * `Label` outside it, and never passes `errorText` to `Input`.
 */
function FormField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div>
        {children(id)}
        {error ? (
          <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

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
  triggerVariant = "outline",
  triggerSize = "sm",
  onSubmit,
}: {
  mode: "add" | "edit";
  groups: readonly DirectoryGroup[];
  /** Required in edit mode, for the starting values and the dialog title. */
  tool?: DirectoryTool;
  /** Add mode only: which group the new tool's select should preselect. */
  defaultGroupKey?: string;
  triggerLabel: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  triggerSize?: "sm" | "default";
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
      <Button type="button" variant={triggerVariant} size={triggerSize} onClick={() => setOpen(true)}>
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
            <FormField id={`${formId}-name`} label="Name" error={fieldError("name")}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  disabled={pending}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </FormField>

            {/* No pattern validation here: the DNS-label rule already lives
                in Go's domain.SubdomainPattern and the SQL CHECK, bound by a
                test. A third copy in TypeScript would need its own drift
                test and would rot. The API's 422 is the authority. */}
            <FormField id={`${formId}-subdomain`} label="Subdomain" error={fieldError("subdomain")}>
              {(id) => (
                <Input
                  id={id}
                  value={subdomain}
                  disabled={pending}
                  required
                  onChange={(event) => setSubdomain(event.target.value)}
                />
              )}
            </FormField>

            <FormField id={`${formId}-purpose`} label="Purpose" error={fieldError("purpose")}>
              {(id) => (
                <Input
                  id={id}
                  value={purpose}
                  disabled={pending}
                  required
                  onChange={(event) => setPurpose(event.target.value)}
                />
              )}
            </FormField>

            <FormField id={`${formId}-note`} label="Note (optional)" error={fieldError("note")}>
              {(id) => (
                <Input
                  id={id}
                  value={note}
                  disabled={pending}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </FormField>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-group`}>Group</Label>
              <Select name="groupKey" value={groupKey} onValueChange={setGroupKey} disabled={pending}>
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
