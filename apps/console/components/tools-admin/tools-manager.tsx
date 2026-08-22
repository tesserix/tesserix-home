"use client";

import { useState } from "react";
import { Button } from "@tesserix/web";
import type { DirectoryGroup, DirectoryTool, ToolsDirectory } from "@/lib/tools-directory";
import type { ToolInput } from "@/lib/tools-write";
import { addToolAction, editToolAction, removeToolAction } from "@/app/(console)/platform/tools/actions";
import { ToolForm } from "./tool-form";

/**
 * The grouped management view. Task 1 renders it read-only so the page's
 * gates can be tested on their own; this task adds the add/edit form and
 * per-row delete. Tasks 5-7 add group and reorder controls.
 *
 * `import type` for ToolsDirectory, never a value import: lib/tools-directory
 * begins with `import "server-only"` and this is a client component. tsc
 * cannot tell the two apart — only the bundler can, which is why Step 8 runs
 * the build.
 */
export function ToolsManager({ directory }: { directory: ToolsDirectory }) {
  return (
    <div className="flex flex-col gap-6">
      {directory.groups.map((group) => {
        const tools = directory.tools.filter((tool) => tool.groupKey === group.key);
        return (
          <section key={group.key} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {group.label}
              </h3>
              <ToolForm
                mode="add"
                groups={directory.groups}
                defaultGroupKey={group.key}
                triggerLabel="Add tool"
                onSubmit={(input: ToolInput) => addToolAction(input)}
              />
            </div>
            {tools.length === 0 ? (
              // Shown here and NOT on the home page, deliberately — see the
              // comment in components/internal-tools.tsx. A group you just
              // created is empty, and hiding it would make creation look like
              // it silently failed.
              <p className="text-sm text-muted-foreground">No tools in this group yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tools.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} groups={directory.groups} />
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
 * One tool's row, with its own Edit form and its own delete confirmation.
 *
 * The confirmation is inline rather than a second dialog: it replaces this
 * row's normal content with the confirmation copy, so the tool's name is
 * never rendered twice at once (a modal layered over an unchanged row would
 * leave the name matchable in two places, which is exactly what a screen
 * reader — and `getByText` — would trip on).
 */
function ToolRow({ tool, groups }: { tool: DirectoryTool; groups: readonly DirectoryGroup[] }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (confirming) {
    return (
      <li className="flex items-center justify-between gap-2 text-sm">
        <span>
          Delete <span className="font-medium">{tool.name}</span>? This can&apos;t be undone.
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              const result = await removeToolAction(tool.id);
              setPending(false);
              if (result.ok) setConfirming(false);
            }}
          >
            Delete tool
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span>
        <span className="font-medium">{tool.name}</span>{" "}
        <span className="text-muted-foreground">{tool.subdomain}</span>
        {tool.note ? (
          <span className="block text-xs text-muted-foreground">{tool.note}</span>
        ) : null}
      </span>
      <div className="flex gap-2">
        <ToolForm
          mode="edit"
          groups={groups}
          tool={tool}
          triggerLabel="Edit"
          onSubmit={(input: ToolInput) => editToolAction(tool.id, input)}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Delete
        </Button>
      </div>
    </li>
  );
}
