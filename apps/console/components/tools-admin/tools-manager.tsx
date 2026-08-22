"use client";

import { useState, type ReactNode } from "react";
import { Button, Callout, CalloutDescription } from "@tesserix/web";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import type { DirectoryGroup, DirectoryTool, ToolsDirectory } from "@/lib/tools-directory";
import type { ToolInput } from "@/lib/tools-write";
import {
  addToolAction,
  editToolAction,
  removeToolAction,
  moveToolAction,
  addGroupAction,
  renameGroupAction,
  removeGroupAction,
  moveGroupAction,
} from "@/app/(console)/platform/tools/actions";
import { ToolForm } from "./tool-form";
import { GroupForm } from "./group-form";

/**
 * The grouped management view. Task 1 renders it read-only so the page's
 * gates can be tested on their own; Task 4 added the tool add/edit form and
 * per-row delete; this task adds the same for groups (add, rename, delete).
 * Tasks 6-7 add reorder controls.
 *
 * `import type` for ToolsDirectory, never a value import: lib/tools-directory
 * begins with `import "server-only"` and this is a client component. tsc
 * cannot tell the two apart — only the bundler can, which is why Step 8 runs
 * the build.
 */
export function ToolsManager({ directory }: { directory: ToolsDirectory }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Groups
        </h2>
        <GroupForm mode="add" triggerLabel="Add group" onSubmit={(input) => addGroupAction(input)} />
      </div>
      {directory.groups.map((group, groupIndex) => {
        const tools = directory.tools.filter((tool) => tool.groupKey === group.key);
        const previousGroup = directory.groups[groupIndex - 1];
        const nextGroup = directory.groups[groupIndex + 1];
        return (
          <section key={group.key} className="flex flex-col gap-2">
            <GroupHeader group={group} previousGroup={previousGroup} nextGroup={nextGroup}>
              <ToolForm
                mode="add"
                groups={directory.groups}
                defaultGroupKey={group.key}
                triggerLabel="Add tool"
                triggerAriaLabel={`Add tool to ${group.label}`}
                onSubmit={(input: ToolInput) => addToolAction(input)}
              />
            </GroupHeader>
            {tools.length === 0 ? (
              // Shown here and NOT on the home page, deliberately — see the
              // comment in components/internal-tools.tsx. A group you just
              // created is empty, and hiding it would make creation look like
              // it silently failed.
              <p className="text-sm text-muted-foreground">No tools in this group yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tools.map((tool, toolIndex) => (
                  <ToolRow
                    key={tool.id}
                    tool={tool}
                    groups={directory.groups}
                    previousTool={tools[toolIndex - 1]}
                    nextTool={tools[toolIndex + 1]}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * One group's heading row: label, Rename, Delete, and (via `children`) that
 * group's own "Add tool" trigger.
 *
 * The delete control's visible text is "Delete" — mirroring `ToolRow` — so
 * that once the confirmation dialog is open, only the dialog's own "Delete
 * group" button carries that literal text. But "Delete" alone collides with
 * every `ToolRow`'s own "Delete" button once more than one group is on the
 * page, and a positional `getAllByRole(...)[0]` query over that collision is
 * exactly the brittle-under-reorder shape this surface hit twice already
 * (here and in `ToolRow`) — so both delete buttons, plus this header's own
 * "Add tool" trigger, carry an `aria-label` that names the group or tool
 * they belong to. `aria-label` overrides the accessible name without
 * changing the rendered text, so the visible label stays "Delete" / "Add
 * tool" while a query can address the control unambiguously by name instead
 * of by position.
 */
function GroupHeader({
  group,
  previousGroup,
  nextGroup,
  children,
}: {
  group: DirectoryGroup;
  previousGroup?: DirectoryGroup;
  nextGroup?: DirectoryGroup;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
  };

  const confirmDelete = async () => {
    setError(null);
    setPending(true);
    const result = await removeGroupAction(group.key);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
  };

  const move = async (neighbour: DirectoryGroup) => {
    setMoveError(null);
    const result = await moveGroupAction(
      { key: group.key, sortOrder: group.sortOrder },
      { key: neighbour.key, sortOrder: neighbour.sortOrder },
    );
    // A failed move is not silently swallowed: the seam's own message is
    // shown here, the same way a failed delete is above.
    if (!result.ok) setMoveError(result.message);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {group.label}
        </h3>
        <div className="flex items-center gap-2">
          {previousGroup ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move group up: ${group.label}`}
              onClick={() => void move(previousGroup)}
            >
              Move group up
            </Button>
          ) : null}
          {nextGroup ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move group down: ${group.label}`}
              onClick={() => void move(nextGroup)}
            >
              Move group down
            </Button>
          ) : null}
          <GroupForm
            mode="rename"
            group={group}
            triggerLabel="Rename"
            onSubmit={(input) => renameGroupAction(group.key, input.label)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Delete ${group.label}`}
            onClick={() => setOpen(true)}
          >
            Delete
          </Button>
          {children}
        </div>
      </div>
      {moveError ? (
        <Callout role="alert" variant="destructive">
          <CalloutDescription>{moveError}</CalloutDescription>
        </Callout>
      ) : null}
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Delete ${group.label}?`}
        description="This removes the group from the directory. This can't be undone."
        confirmLabel="Delete group"
        confirmId={`delete-group-confirm-${group.key}`}
        loading={pending}
        onConfirm={() => void confirmDelete()}
      >
        {/* The API's 409 for a populated group ("Move or remove the tools in
            this group first.") is not silently swallowed: it is shown here
            rather than discarded. */}
        {error ? (
          <Callout role="alert" variant="destructive">
            <CalloutDescription>{error}</CalloutDescription>
          </Callout>
        ) : null}
      </DestructiveConfirmDialog>
    </div>
  );
}

/**
 * One tool's row, with its own Edit form and its own delete confirmation.
 *
 * The confirmation is `DestructiveConfirmDialog` — the same shared shell
 * `organisation-detail-view.tsx` uses for organisation delete and contact
 * erasure — rather than a hand-rolled inline swap: that shell already carries
 * a focus trap, return-focus-on-close and Escape-to-cancel from `Dialog`,
 * which an inline replacement of the row's own content would have had to
 * reimplement (and, on the first pass here, did not).
 */
function ToolRow({
  tool,
  groups,
  previousTool,
  nextTool,
}: {
  tool: DirectoryTool;
  groups: readonly DirectoryGroup[];
  previousTool?: DirectoryTool;
  nextTool?: DirectoryTool;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
  };

  const confirmDelete = async () => {
    setError(null);
    setPending(true);
    const result = await removeToolAction(tool.id);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
  };

  const move = async (neighbour: DirectoryTool) => {
    setMoveError(null);
    const result = await moveToolAction(
      { id: tool.id, sortOrder: tool.sortOrder },
      { id: neighbour.id, sortOrder: neighbour.sortOrder },
    );
    // A failed move is not silently swallowed: the seam's own message is
    // shown here, the same way a failed delete is below.
    if (!result.ok) setMoveError(result.message);
  };

  return (
    <li className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="font-medium">{tool.name}</span>{" "}
          <span className="text-muted-foreground">{tool.subdomain}</span>
          {tool.note ? (
            <span className="block text-xs text-muted-foreground">{tool.note}</span>
          ) : null}
        </span>
        <div className="flex gap-2">
          {previousTool ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move up: ${tool.name}`}
              onClick={() => void move(previousTool)}
            >
              Move up
            </Button>
          ) : null}
          {nextTool ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move down: ${tool.name}`}
              onClick={() => void move(nextTool)}
            >
              Move down
            </Button>
          ) : null}
          <ToolForm
            mode="edit"
            groups={groups}
            tool={tool}
            triggerLabel="Edit"
            onSubmit={(input: ToolInput) => editToolAction(tool.id, input)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Delete ${tool.name}`}
            onClick={() => setOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>
      {moveError ? (
        <Callout role="alert" variant="destructive">
          <CalloutDescription>{moveError}</CalloutDescription>
        </Callout>
      ) : null}
      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Delete ${tool.name}?`}
        description="This removes the tool from the directory. This can't be undone."
        confirmLabel="Delete tool"
        confirmId={`delete-tool-confirm-${tool.id}`}
        loading={pending}
        onConfirm={() => void confirmDelete()}
      >
        {/* A failed delete is not silently swallowed: the seam's own message
            ("You do not have permission…", "That entry may have been
            removed…") is shown here rather than discarded. */}
        {error ? (
          <Callout role="alert" variant="destructive">
            <CalloutDescription>{error}</CalloutDescription>
          </Callout>
        ) : null}
      </DestructiveConfirmDialog>
    </li>
  );
}
