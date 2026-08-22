import { ExternalLink } from "lucide-react";
import { toolUrl } from "@tesserix/console-core";
import type { DirectoryTool, ToolsDirectory } from "@/lib/tools-directory";

/**
 * The estate's internal tools, grouped.
 *
 * A directory rather than a dashboard: these are links out to living systems,
 * which Decision 3 of the console spec allows precisely because they are not
 * `apps/web`. Nothing here reports status — see `tools.ts` for why.
 *
 * The base domain is configuration, not a constant, so a non-production console
 * does not hand operators links into production.
 */

function ToolLink({ tool, baseDomain }: { tool: DirectoryTool; baseDomain: string }) {
  return (
    <li>
      <a
        href={toolUrl(tool, baseDomain)}
        target="_blank"
        // `noopener` matters on target="_blank": without it the opened page can
        // reach back through window.opener. `noreferrer` keeps the console's
        // URL out of the tool's referer logs.
        rel="noopener noreferrer"
        className="group flex h-full flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{tool.name}</span>
          <ExternalLink
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </span>
        <span className="text-xs leading-relaxed text-muted-foreground">
          {tool.purpose}
        </span>
        {tool.note ? (
          <span className="mt-auto pt-1 text-[11px] text-muted-foreground/70">
            {tool.note}
          </span>
        ) : null}
      </a>
    </li>
  );
}

export function InternalTools({
  baseDomain,
  directory,
}: {
  baseDomain: string;
  directory: ToolsDirectory;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="tools-heading">
      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <h2 id="tools-heading" className="text-base font-semibold">
          Internal tools
        </h2>
        <p className="text-sm text-muted-foreground">
          Where to look when the console does not hold the answer. These open in
          a new tab and are not part of the console — some ask for their own
          sign-in.
        </p>
        {directory.source === "degraded" && (
          // Not an error surface. The directory is correct and usable; what is
          // being reported is that it could not be confirmed against the live
          // one, which is the difference between a stale list and a wrong one.
          <p className="text-xs text-muted-foreground">
            Live directory unavailable — showing the built-in list.
          </p>
        )}
      </div>

      {directory.groups.map((group) => {
        const tools = directory.tools.filter((tool) => tool.groupKey === group.key);
        // Groups now live in a database table, so an empty one is possible at
        // runtime for the first time — the data tests that used to forbid this
        // case applied only to the code literal. This is the only thing left
        // standing between an empty group and a bare heading.
        //
        // A declared-but-empty group would render as a heading over nothing,
        // which reads as a loading failure rather than an absence.
        //
        // The MANAGEMENT surface deliberately does the opposite and shows
        // empty groups (components/tools-admin/tools-manager.tsx): a group an
        // operator just created is empty, and hiding it there would make
        // creation look like it silently failed. Two surfaces, two audiences,
        // one deliberate divergence — not an inconsistency to reconcile.
        if (tools.length === 0) return null;
        return (
          <div key={group.key} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {group.label}
            </h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {tools.map((tool) => (
                <ToolLink key={tool.subdomain} tool={tool} baseDomain={baseDomain} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
