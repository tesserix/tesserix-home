import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state`, not `states`: this is a server component,
// and `states.tsx` is a "use client" module whose exports become client
// references that throw when called on the server. See
// `crm/page.tsx`/`crm/[organisation]/page.tsx` for the incident this guards
// against. Rendering the state (`SurfaceStateView`) is left to
// `SuppressionsView`, a client component, the same way `DetailLayout`
// renders it for the organisation detail page rather than this page doing
// so itself.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { listSuppressions, type SuppressionRow } from "@/lib/db/crm-repo";
import { SuppressionsView } from "./suppressions-view";

/**
 * The do-not-contact list.
 *
 * Ships before Task 8 (import): a suppression added after the first import
 * cannot retroactively protect anyone it should have — see crm-repo.ts's
 * suppressions section for the full reasoning.
 */

export const EMPTY_MESSAGE = "Nobody is on the do-not-contact list.";

export function suppressionsState(input: {
  error: unknown;
  rows: readonly SuppressionRow[];
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.rows,
    filtered: false,
  });
}

export default async function CrmSuppressionsPage() {
  let rows: SuppressionRow[] = [];
  let error: unknown = null;
  try {
    rows = await listSuppressions();
  } catch (caught) {
    error = caught;
  }

  const state = suppressionsState({ error, rows });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Do-not-contact list"
        description="People and businesses who asked not to be contacted. Checked before an outbound email or DM."
      />

      <SuppressionsView suppressions={rows} state={state} emptyMessage={EMPTY_MESSAGE} />
    </div>
  );
}
