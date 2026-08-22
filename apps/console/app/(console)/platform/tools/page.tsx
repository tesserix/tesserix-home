import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { requiresCapability } from "@/lib/internal-access";
import { readToolsDirectory } from "@/lib/tools-directory";
import { ToolsManager } from "@/components/tools-admin/tools-manager";

/**
 * Managing the internal tools directory.
 *
 * Three gates before anything is editable, answering three different
 * questions with three different remedies:
 *
 *   - `platform` capability — may you.
 *   - PLATFORM_API_ORIGIN unset — the console is serving the built-in literal
 *     and there is nothing to write to. Switched off; the remedy is
 *     configuration, not retrying.
 *   - source === "degraded" — the origin IS set and the API could not be
 *     reached. The remedy is to find out why, and retrying may work.
 *
 * Collapsing the last two into one message is the exact defect that
 * three-valued `DirectorySource` was introduced to fix, one layer up.
 */
export default async function ToolsPage() {
  const session = await getCurrentSession();
  const mayManage = !requiresCapability() || hasCapability(session?.roles, "platform");

  if (!mayManage) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          You do not have permission to manage the tools directory. It needs the
          platform capability.
        </p>
      </Shell>
    );
  }

  const directory = await readToolsDirectory();

  if (directory.source === "builtin") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          Directory management is switched off. The console is serving the
          built-in list because PLATFORM_API_ORIGIN is not set, so there is
          nothing to edit.
        </p>
      </Shell>
    );
  }

  if (directory.source === "degraded") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          The platform API could not be reached, so the directory cannot be
          edited right now. The home page is showing the built-in list.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ToolsManager directory={directory} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Tools directory"
        description="What the console links to, and how it is grouped."
      />
      {children}
    </div>
  );
}
