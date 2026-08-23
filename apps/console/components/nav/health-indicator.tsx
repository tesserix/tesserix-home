"use client";

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
 */

export function HealthIndicator({
  health,
}: {
  readonly health: EstateHealth;
}): React.JSX.Element {
  const presentation = HEALTH_PRESENTATION[health.state];

  return (
    <span
      // `status` rather than `alert`: this is ambient, and an alert would
      // interrupt a screen reader on every navigation.
      role="status"
      aria-label={describeHealth(health)}
      title={describeHealth(health)}
      className={`flex items-center gap-1.5 text-xs ${presentation.text}`}
    >
      <span aria-hidden="true" className={presentation.dot} />
      <span className="hidden sm:inline">{presentation.label}</span>
      {health.stale ? <span className="hidden sm:inline">(stale)</span> : null}
    </span>
  );
}
