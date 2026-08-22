"use client";

import type { ToolsDirectory } from "@/lib/tools-directory";

/**
 * The grouped management view. Task 1 renders it read-only so the page's
 * gates can be tested on their own; Tasks 4-7 add the controls.
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
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {group.label}
            </h3>
            {tools.length === 0 ? (
              // Shown here and NOT on the home page, deliberately — see the
              // comment in components/internal-tools.tsx. A group you just
              // created is empty, and hiding it would make creation look like
              // it silently failed.
              <p className="text-sm text-muted-foreground">No tools in this group yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tools.map((tool) => (
                  <li key={tool.id} className="text-sm">
                    <span className="font-medium">{tool.name}</span>{" "}
                    <span className="text-muted-foreground">{tool.subdomain}</span>
                    {tool.note ? (
                      <span className="block text-xs text-muted-foreground">{tool.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
