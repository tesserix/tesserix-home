import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a "use client" module whose exports become client references
// that throw when called on the server. Same guard `suppressions/page.tsx`
// carries, for the same incident. Rendering the state (`SurfaceStateView`) is
// left to `TemplatesView`, a client component.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// Not `toSurfaceError` — see `@/lib/db-read-error`.
import { dbReadError } from "@/lib/db-read-error";
import { listTemplates, type TemplateRow } from "@/lib/db/crm-templates";
import { TemplatesView } from "./templates-view";

/**
 * Where an operator authors the outreach copy the composer renders (#LDQ).
 *
 * ARCHIVED ROWS ARE NOT SHOWN, because `listTemplates` excludes them by
 * default and this surface does not ask for them. Archiving is how a template
 * is retired, and a retired template still visible in the authoring list is
 * one an operator will reasonably assume is still in the composer's picker —
 * which it is not. The history is not lost: the row survives so that
 * `crm_activities.metadata.template_id` still resolves for every DM already
 * logged against it, which is the whole reason archiving exists instead of
 * deletion.
 */

export const EMPTY_MESSAGE = "No templates yet.";

export function templatesState(input: {
  error: unknown;
  rows: readonly TemplateRow[];
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: dbReadError(input.error, "the lead templates"),
    rows: input.rows,
    filtered: false,
  });
}

export default async function CrmTemplatesPage() {
  let rows: TemplateRow[] = [];
  let error: unknown = null;
  try {
    rows = await listTemplates();
  } catch (caught) {
    error = caught;
  }

  const state = templatesState({ error, rows });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Lead templates"
        // Says what the surface is AND what it is not. "Nothing is sent from
        // here" is the sentence that stops an operator looking for a send
        // button and concluding the page is broken — this feature copies to
        // the clipboard and logs, deliberately, and the absence of a send path
        // is the design rather than an unfinished edge.
        description="Reusable outreach copy. Rendered per lead; nothing is sent from here."
        breadcrumbs={[{ label: "CRM", href: "/platform/crm" }, { label: "Templates" }]}
      />

      <TemplatesView templates={rows} state={state} emptyMessage={EMPTY_MESSAGE} />
    </div>
  );
}
