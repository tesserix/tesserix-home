import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { FeatureFlagWorkspace } from "@/components/feature-flags/feature-flag-workspace";
import {
  fetchHelivantaFeatureFlags,
  fetchHelivantaFlagCommands,
} from "@/lib/feature-flags";
import type {
  FeatureFlagCommand,
  FeatureFlagSnapshot,
} from "@/lib/feature-flags-contract";
import {
  changeHelivantaFeatureFlag,
  recoverHelivantaFeatureFlag,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function HelivantaFeatureFlagsPage() {
  const session = await getCurrentSession();
  if (!hasCapability(session?.roles, "platform"))
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Platform access is required to view Helivanta release controls.
      </p>
    );
  let snapshot: FeatureFlagSnapshot | null = null;
  let commands: FeatureFlagCommand[] | null = null;
  let error: string | undefined;
  try {
    snapshot = await fetchHelivantaFeatureFlags();
    commands = snapshot.commands;
  } catch {
    error =
      "The released catalogue or private provider could not be read. Refresh to retry, or check the management connection.";
    try {
      commands = await fetchHelivantaFlagCommands();
    } catch {
      commands = null;
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Helivanta"
        description="Staff, PharmaConnect and the complete declared release catalogue."
        breadcrumbs={[
          { label: "Platform", href: "/" },
          { label: "Feature flags", href: "/platform/feature-flags" },
          { label: "Helivanta" },
        ]}
      />
      <FeatureFlagWorkspace
        snapshot={snapshot}
        commands={commands}
        error={error}
        canManage={
          hasCapability(session?.roles, "platform") &&
          hasCapability(session?.roles, "manage-feature-flags")
        }
        operatorSubject={session?.sub ?? ""}
        onChangeAction={changeHelivantaFeatureFlag}
        onRecoverAction={recoverHelivantaFeatureFlag}
      />
    </div>
  );
}
