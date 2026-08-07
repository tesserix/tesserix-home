import Link from "next/link";

import { FeedbackTable } from "./feedback-table";
import { KoraAdminError, listKoraFeedback, type KoraFeedback } from "@/lib/api/kora-admin";

// Server component, matching the audit trail: paging is plain links against
// `?offset=`, so the page stays server-rendered, shareable and
// back-button-correct.
const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
] as const;

const KIND_OPTIONS = [
  { value: "", label: "All" },
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
] as const;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Next.js hands back `string | string[]` for a repeated query key — taking the
// value unnarrowed lets `?status=a&status=b` stringify to "a,b" via
// Array#toString. Same guard the audit trail and food index use.
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildHref(params: { status: string; kind: string; offset: number }): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.kind) qs.set("kind", params.kind);
  if (params.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return `/admin/apps/kora/feedback${query ? `?${query}` : ""}`;
}

export default async function KoraFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string | string[];
    kind?: string | string[];
    offset?: string | string[];
  }>;
}) {
  const sp = await searchParams;
  // The operator's question on opening this page is "what needs my
  // attention", not "what has ever been submitted" — so an ABSENT status
  // param defaults to "open". An explicitly empty string ("" — the "All"
  // filter link) must be respected as-is, not re-defaulted: `??` only
  // fires on undefined, so `status=""` on the URL stays "".
  const status = firstParam(sp.status) ?? "open";
  const kind = firstParam(sp.kind) ?? "";
  const parsedOffset = Number.parseInt(firstParam(sp.offset) ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let items: KoraFeedback[] = [];
  let total = 0;
  let loadError: KoraAdminError | null = null;

  try {
    const page = await listKoraFeedback({
      status: status || undefined,
      kind: kind || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    items = page.items;
    total = page.total;
  } catch (err) {
    loadError =
      err instanceof KoraAdminError
        ? err
        : new KoraAdminError(0, "unknown_error", err instanceof Error ? err.message : String(err));
  }

  // A hand-edited or stale URL can carry an offset past the end — the pager
  // never produces one. Handled as real input, same as the audit trail.
  const isOutOfRange = !loadError && total > 0 && offset > 0 && items.length === 0;
  const lastValidOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const rangeStart = total === 0 ? 0 : Math.min(offset + 1, total);
  const rangeEnd = total === 0 ? 0 : Math.min(offset + items.length, total);
  const hasPrev = offset > 0;
  const hasNext = rangeEnd < total;
  const prevOffset = isOutOfRange ? lastValidOffset : Math.max(0, offset - PAGE_SIZE);

  const rangeLabel = loadError
    ? "In-app feedback submitted through Kora"
    : isOutOfRange
      ? `Offset ${formatCount(offset)} is past the end of this filter (${formatCount(total)} total)`
      : `Showing ${formatCount(rangeStart)}–${formatCount(rangeEnd)} of ${formatCount(total)}`;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Feedback</h1>
        <p className="text-sm text-muted-foreground">{rangeLabel}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Status</span>
          <div className="flex gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <Link
                key={opt.value || "all"}
                href={buildHref({ status: opt.value, kind, offset: 0 })}
                aria-current={status === opt.value ? "page" : undefined}
                className={`rounded-md border px-2.5 py-1 ${
                  status === opt.value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:bg-muted"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Kind</span>
          <div className="flex gap-1">
            {KIND_OPTIONS.map((opt) => (
              <Link
                key={opt.value || "all"}
                href={buildHref({ status, kind: opt.value, offset: 0 })}
                aria-current={kind === opt.value ? "page" : undefined}
                className={`rounded-md border px-2.5 py-1 ${
                  kind === opt.value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:bg-muted"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p className="font-medium">Feedback could not be loaded.</p>
          <p className="mt-1">
            Status {loadError.status} — {loadError.code}
            {loadError.message ? `: ${loadError.message}` : ""}
          </p>
        </div>
      ) : (
        <>
          <FeedbackTable
            items={items}
            emptyLabel={
              isOutOfRange
                ? `That page doesn't exist — this filter has ${formatCount(total)} entries.`
                : "No feedback matches this filter."
            }
          />

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{rangeLabel}</span>
            <div className="flex gap-2">
              <Link
                href={buildHref({ status, kind, offset: prevOffset })}
                aria-disabled={!hasPrev}
                tabIndex={hasPrev ? undefined : -1}
                className={`rounded-md border border-border px-3 py-1.5 ${
                  hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-40"
                }`}
              >
                Previous
              </Link>
              <Link
                href={buildHref({ status, kind, offset: offset + PAGE_SIZE })}
                aria-disabled={!hasNext}
                tabIndex={hasNext ? undefined : -1}
                className={`rounded-md border border-border px-3 py-1.5 ${
                  hasNext ? "hover:bg-muted" : "pointer-events-none opacity-40"
                }`}
              >
                Next
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export { buildHref };
