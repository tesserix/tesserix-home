"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { consolePath, isRouteActive } from "@tesserix/console-core";
import { NavIcon } from "./icon";
import type { EstateHealth } from "@/lib/health";
import { describeHealth, HEALTH_PRESENTATION } from "@/lib/health-presentation";

/**
 * The estate's health, in the console header.
 *
 * # Three states, and the third is the point
 *
 * `unmeasured` is not a paler `healthy`. It is a different colour, a
 * different word and a different accessible name, because the failure this
 * indicator exists to prevent is an operator reading "nothing measured this"
 * as "everything is fine". See the head of the health module in platform-api.
 *
 * # Why colour is never alone
 *
 * WCAG 2.1 AA, and self-interest: the operator with a red/green deficiency is
 * the one who most needs a word here. Every state carries its name in text
 * and a fuller sentence in aria-label.
 *
 * The shapes and the wording both come from `lib/health-presentation.ts`,
 * shared with the health page this indicator links to — see that module's
 * head comment for why restating either here would be a mistake.
 *
 * Below `sm` the text label and the `(stale)` mark are hidden, so the dot is
 * the entire indicator. No test can catch a viewport-only regression here:
 * jsdom has no viewport.
 *
 * # `aria-current` when it points at the page you are on
 *
 * This renders in the header on EVERY console page, including the health page
 * itself, where it is a link to the current location. The sidebar already
 * solves that — `isRouteActive(pathname, route, "console")` plus
 * `aria-current="page"` — so this reuses that mechanism rather than inventing a
 * second one that could disagree with it about what "active" means.
 *
 * # A link, but `role="status"` stays off the link
 *
 * This now navigates to the health page (`platform.serviceHealth`, resolved
 * through `consolePath` rather than a hardcoded string — see
 * `components/nav/sidebar.tsx` for the same pattern). `status` on an anchor
 * would fight the link semantics: the control needs to be announced as a
 * link, and a link's accessible name is computed from its content unless the
 * link itself carries `aria-label`. So `aria-label`/`role="status"` stay on
 * an INNER span; the browser's name-from-content walk picks up that span's
 * `aria-label` as its contribution to the anchor's name, which is how the
 * link ends up with the full sentence as its accessible name instead of
 * collapsing to the bare state word.
 */

export function HealthIndicator({
  health,
}: {
  readonly health: EstateHealth;
}): React.JSX.Element {
  const presentation = HEALTH_PRESENTATION[health.state];
  const description = describeHealth(health);
  const pathname = usePathname();
  const onHealthPage = isRouteActive(pathname ?? "", "platform.serviceHealth", "console");

  return (
    <Link
      href={consolePath("platform.serviceHealth")}
      // No `title`. It carried the same string as the inner span's
      // `aria-label`, so a screen reader announced the sentence twice — once
      // as the accessible name and once as the description. Harmless while the
      // span was not focusable; this is a link in the tab order on every
      // console page now. The `aria-label` is the accessible name.
      aria-current={onHealthPage ? "page" : undefined}
      className={`flex items-center gap-1.5 text-xs ${presentation.text}`}
    >
      <NavIcon name="heart-pulse" className="size-3.5 shrink-0" />
      <span
        // `status` rather than `alert`: this is ambient, and an alert would
        // interrupt a screen reader on every navigation. Living on this
        // inner span (not the anchor) is what keeps the control announced
        // as a link while still carrying the full sentence as its name.
        role="status"
        aria-label={description}
        className="flex items-center gap-1.5"
      >
        <span aria-hidden="true" className={presentation.dot} />
        <span className="hidden sm:inline">{presentation.label}</span>
        {health.stale ? <span className="hidden sm:inline">(stale)</span> : null}
      </span>
    </Link>
  );
}
