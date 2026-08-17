import { ConsolePageHeader } from "@/components/kit/page-header";
import { ImportView } from "./import-view";

/**
 * CSV import for the CRM (Task 8).
 *
 * No data to load here — unlike the queue and the do-not-contact list, this
 * page has no server-rendered read: parsing a CSV happens client-side, and
 * the preview/commit steps are server actions the client component below
 * calls directly. That's why this file, unlike `crm/page.tsx` or
 * `suppressions/page.tsx`, never needs `resolveState`/`toSurfaceError` —
 * there is no read to resolve a state for.
 */
export default function CrmImportPage() {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Import leads"
        description="Upload a CSV, preview what it will create, then commit. Suppressed contacts are skipped at both steps."
        breadcrumbs={[{ label: "CRM", href: "/platform/crm" }, { label: "Import" }]}
      />
      <ImportView />
    </div>
  );
}
