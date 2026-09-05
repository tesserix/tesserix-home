import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. Same comment as
// `kora/page.tsx` and `[product]/page.tsx`, same incident.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { fetchEmailTemplates } from "@/lib/platform-api";
import {
  failureSentence,
  type EmailTemplateFailure,
  type EmailTemplateRow,
} from "@/lib/email-templates";
import { EmailTemplatesView } from "./email-templates-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email templates" };

export const EMPTY_MESSAGE =
  "mark8ly reports no transactional email templates. Keys are registered by the product's own code, so an empty registry means no call site has declared one.";

export interface EmailTemplatesStateInput {
  error: unknown;
  rows: readonly EmailTemplateRow[];
  failures: readonly EmailTemplateFailure[];
}

/**
 * Which state the listing is in.
 *
 * `filtered: false` always, because this surface has no filters. The key set
 * is closed and owned by mark8ly's code — a few dozen entries that cannot grow
 * at runtime — so platform-api serves it unpaged and this page shows all of
 * it. A `filtered-empty` state here would be unreachable copy.
 *
 * # NO ROWS AND A FAILURE IS NOT `empty`
 *
 * `resolveState` decides on `rows.length` and knows nothing about `failures`,
 * so a source that answered 500 would resolve to `empty` and render "Nothing
 * here yet" — the exact lie `failures` exists to prevent. The HTTP response is
 * a genuine 200, so the transport cannot catch this; it is decided here, where
 * both halves of the payload are in hand. When SOME source answered, the rows
 * are shown and the view renders the failure beside them as a partial listing.
 */
export function emailTemplatesState(input: EmailTemplatesStateInput): SurfaceState {
  if (input.error === null && input.rows.length === 0 && input.failures.length > 0) {
    return {
      kind: "error",
      message: `The registry could not be read, so this is not an empty list. ${failureSentence(input.failures)}`,
    };
  }
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.rows,
    filtered: false,
  });
}

/**
 * mark8ly's transactional email registry (#588, epic #586).
 *
 * Replaces apps/web's `/admin/apps/mark8ly/notifications/templates`, which
 * reached these rows by CONNECTING TO MARK8LY'S DATABASE and pinging an
 * internal endpoint to evict the send path's cache. This page reaches them the
 * way the console reaches everything else — platform-api's `emailtemplates`
 * module over HMAC-signed federation — and the console holds no mark8ly
 * credential at all.
 *
 * # The read is not gated here beyond the route gate
 *
 * Reaching `/mark8ly/email-templates` already requires `platform`: routes.ts
 * declares the capability on `mark8ly.emailTemplates` and the access gate
 * resolves a request path through the route table (#262). A second check in
 * this component would be a different gate free to disagree with that one. The
 * WRITES gate themselves, in `actions.ts`, and the test send gates on
 * `mass-send` on top of that.
 */
export default async function EmailTemplatesPage() {
  let templates: EmailTemplateRow[] = [];
  let failures: EmailTemplateFailure[] = [];
  let error: unknown = null;
  try {
    const page = await fetchEmailTemplates();
    templates = page.templates;
    failures = page.failures;
  } catch (caught) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Email templates"
        description="The transactional email mark8ly sends to merchants and their customers."
        breadcrumbs={[{ label: "mark8ly", href: "/mark8ly" }, { label: "Email templates" }]}
      />

      <EmailTemplatesView
        rows={templates}
        failures={failures}
        state={emailTemplatesState({ error, rows: templates, failures })}
        emptyMessage={EMPTY_MESSAGE}
      />
    </div>
  );
}
