// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. Load-bearing even though nothing
// here uses a hook.
"use client";

import Link from "next/link";
import { Button } from "@tesserix/web";

export interface ResultPagerProps {
  /**
   * What the surface is paging through, lower-case and plural
   * ("organisations", "the drifting queue"). Required, not optional: it is
   * the only thing distinguishing two pagers on one page (see below).
   */
  label: string;
  /** Rows on this page — `rows.length` at every call site. */
  count: number;
  /** Rows matching the filters, ignoring the page limit. */
  total: number;
  /** Matching rows sorting ahead of this page; 0 on the first page. */
  precedingCount: number;
  /** Where the next page lives; `null` on the last page. */
  nextHref: string | null;
  /**
   * Where the previous page lives; `null` on the first page. Optional so a
   * surface with nothing behind its first page need not pass it at all — the
   * control renders only when an href is given.
   */
  previousHref?: string | null;
}

/**
 * The position of a page within its matching set, plus the page controls.
 *
 * A range ("101–200 of 259"), not a bare count of the rows on screen: with
 * `count` alone both page 1 and page 2 of a 259-row result read "100 of 259"
 * and an operator could not tell which page they were on.
 *
 * `aria-live="polite"` on the range: it changes both when the operator types
 * a search and when they page, and a screen reader user needs to hear the new
 * count without it stealing focus — WCAG 2.1 AA.
 *
 * The controls are `<a href>`s, not buttons: a page of results is a location,
 * so it must be back-button-navigable and shareable. Each is rendered only
 * when its href is non-null — a dead "next" on the last page promises a page
 * that isn't there.
 *
 * Naming: the visible text stays "Next"/"Previous" (short, and the range sits
 * beside it), but the accessible name is "Next page of {label}" and the whole
 * control is a `<nav>` named "{label} pagination". Two pagers share a page on
 * the CRM queues, and a screen reader user listing links or landmarks would
 * otherwise hear "Next, Next" with nothing to tell them apart.
 */
export function ResultPager({
  label,
  count,
  total,
  precedingCount,
  nextHref,
  previousHref,
}: ResultPagerProps) {
  const first = precedingCount + 1;
  const last = precedingCount + count;

  return (
    <nav aria-label={`${label} pagination`} className="flex items-center justify-between gap-2">
      <span aria-live="polite" className="text-sm text-muted-foreground">
        {first}–{last} of {total}
      </span>
      <span className="flex items-center gap-2">
        {previousHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={previousHref} aria-label={`Previous page of ${label}`}>
              Previous
            </Link>
          </Button>
        ) : null}
        {nextHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={nextHref} aria-label={`Next page of ${label}`}>
              Next
            </Link>
          </Button>
        ) : null}
      </span>
    </nav>
  );
}
