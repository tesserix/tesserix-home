import { randomUUID } from "node:crypto";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { SurfaceStateView } from "@/components/kit/states";
import { resolveState, toSurfaceError } from "@/components/kit/surface-state";
import { requiresCapability } from "@/lib/internal-access";
import { fetchRecoveryStatus } from "@/lib/recovery-api";
import { RecoveryPanel } from "./recovery-panel";

export default async function RecoveryPage() {
  const session = await getCurrentSession();
  const canRun = !requiresCapability() || (hasCapability(session?.roles, "platform") && hasCapability(session?.roles, "rotate-credentials"));
  const header = <ConsolePageHeader title="OpenBao backups" description="Verified recovery points in encrypted cloud storage." breadcrumbs={[{ label: "Secrets", href: "/platform/secrets" }, { label: "Backups" }]} />;
  let status: Awaited<ReturnType<typeof fetchRecoveryStatus>> | null = null;
  let failure: unknown = null;
  try {
    status = await fetchRecoveryStatus();
  } catch (error) {
    failure = error;
  }
  if (!status) {
    return <div className="flex flex-col gap-6">{header}<SurfaceStateView state={resolveState({ isLoading: false, error: toSurfaceError(failure), rows: [], filtered: false })} emptyMessage="No verified backups are available." reauthReturnTo="/platform/secrets/recovery" /></div>;
  }
  return <div className="flex flex-col gap-6">{header}{status.stale ? <p role="alert" className="rounded-lg border border-amber-500 bg-amber-50 p-4 text-sm text-amber-900">No verified backup was captured in the last 14 hours. Check the backup jobs before relying on this recovery window.</p> : null}<RecoveryPanel status={status} canRun={canRun} requestKey={randomUUID()} /></div>;
}
