import { notFound } from "next/navigation";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";

import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a `"use client"` module whose exports resolve to client
// references here. See `components/kit/use-client-boundary.test.ts`.
import { resolveState, toSurfaceError } from "@/components/kit/surface-state";
import { SurfaceStateView } from "@/components/kit/states";
import { fetchEmailTemplate, PlatformApiError } from "@/lib/platform-api";
import { emailTemplateFailureMessage, type EmailTemplateDetail } from "@/lib/email-templates";
import { requiresCapability } from "@/lib/internal-access";
import { TemplateEditor } from "./template-editor";

export const dynamic = "force-dynamic";

/**
 * One mark8ly template, opened for editing (#588).
 *
 * `params.id` is `<source>:<key>` — `mark8ly:orderdoc_invoice` — because two
 * products' registries can hold the same key and mark8ly's own second service
 * has MIRRORED tables (mark8ly#720).
 *
 * IT ARRIVES PERCENT-ENCODED, and an earlier version of this comment claimed
 * the opposite. Next does not decode `%3A` in a dynamic segment, so `params`
 * yields the literal `mark8ly%3Agiftcard_delivery`. `fetchEmailTemplate` then
 * percent-encodes for the API path, producing `mark8ly%253A...`; platform-api
 * decodes once, finds no colon, and refuses it as a bare key — a 400 the
 * console renders as "the request was refused as malformed". Every detail page
 * failed this way in production while the list worked, because only this route
 * carries an encoded id.
 *
 * So decode here, at the boundary where the raw segment enters, and pass a
 * plain `<source>:<key>` inward. Decoding is done defensively: a key that
 * cannot round-trip is passed through unchanged rather than throwing, since
 * `decodeURIComponent` rejects a lone `%`.
 *
 * # For an unauthored key this shows mark8ly's embedded default
 *
 * That is deliberate on the producer's side: the editor opens with what is
 * SENDING, not with empty boxes. It is also the thing most likely to be
 * misread, so the editor says whose copy it is and what saving would do —
 * see `UNAUTHORED_OPENS_THE_DEFAULT`.
 *
 * # The test-send panel is hidden without `mass-send`, and gated anyway
 *
 * Hiding it is UX; `testSendEmailTemplateAction` asserts the capability itself
 * with the live gate, because a hidden button is not a control. The check here
 * reads the SESSION COOKIE synchronously, which is the split #285 preserves —
 * see `lib/auth/render-path-capabilities.test.ts`.
 */
/**
 * One percent-decode of a route segment, tolerating a segment that is not
 * valid encoding.
 *
 * `decodeURIComponent` THROWS on a malformed sequence — a lone `%` is enough —
 * and a thrown error in a server component is a 500 where the honest answer is
 * a 404 for a key that does not exist. Passing the raw value through instead
 * lets the request reach the API and be refused on its merits.
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default async function EmailTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeSegment(rawId);

  let detail: EmailTemplateDetail | null = null;
  let error: unknown = null;
  try {
    detail = await fetchEmailTemplate(id);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      // 404 here is `unknown_key` — no template is stored OR registered under
      // this key. Keys are owned by mark8ly's code, so there is nothing the
      // console could offer to create; the framework 404 is the honest answer.
      notFound();
    }
    error = caught;
  }

  const session = await getCurrentSession();
  const canSend = !requiresCapability() || hasCapability(session?.roles, "mass-send");

  const key = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  // `resolveState` rather than a hand-built `{ kind: "error" }`: it is what
  // keeps the two non-error failures intact — a 501 stays the calm
  // "not wired up" callout and a tokenless session stays "sign in again", both
  // of which a bare error state would render as a red failure with a retry
  // button that cannot help. Only the SENTENCE is substituted, because the
  // per-verb one distinguishes answers the status alone cannot.
  const surfaceError = toSurfaceError(error);
  const message = emailTemplateFailureMessage("open", error);
  const state = resolveState({
    isLoading: false,
    error: surfaceError && {
      ...surfaceError,
      message,
      unavailable: { title: "No email template registry", message },
    },
    rows: detail ? [detail] : [],
    filtered: false,
  });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title={detail?.key ?? key}
        description="One of mark8ly's transactional emails. Editing here writes to mark8ly's own registry."
        breadcrumbs={[
          { label: "mark8ly", href: "/mark8ly" },
          { label: "Email templates", href: "/mark8ly/email-templates" },
          { label: detail?.key ?? key },
        ]}
      />

      {detail ? (
        <TemplateEditor detail={detail} canSend={canSend} />
      ) : (
        <SurfaceStateView
          state={state}
          emptyMessage="This template could not be read."
          reauthReturnTo={`/mark8ly/email-templates/${encodeURIComponent(id)}`}
        />
      )}
    </div>
  );
}
