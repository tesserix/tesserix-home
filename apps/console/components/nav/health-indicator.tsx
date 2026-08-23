"use client";

import type { EstateHealth, HealthState } from "@/lib/health";

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
 */

interface Presentation {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
}

// The console's own semantic tokens — NOT another app's palette. These carry
// the console's dark mode for free, which hardcoded values would not.
const PRESENTATION: Record<HealthState, Presentation> = {
  healthy: {
    label: "Healthy",
    dot: "bg-success",
    text: "text-muted-foreground",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-warning",
    text: "text-foreground",
  },
  unmeasured: {
    // A hollow RING, not a filled dot. Unmeasured differs from healthy in
    // SHAPE as well as colour, so it stays distinguishable to a colour-blind
    // reader and in a monochrome rendering. This is the whole point of the
    // third state and must not be softened into a paler green.
    label: "Unmeasured",
    dot: "border border-muted-foreground bg-transparent",
    text: "text-muted-foreground",
  },
};

function describe(health: EstateHealth): string {
  const parts: string[] = [];

  switch (health.state) {
    case "healthy":
      parts.push(
        `Estate healthy: ${health.workloads.ready} of ${health.workloads.total} workloads and ` +
          `${health.databases.ready} of ${health.databases.total} databases ready.`,
      );
      break;
    case "degraded":
      parts.push(`Estate degraded${health.reason ? `: ${health.reason}.` : "."}`);
      break;
    case "unmeasured":
      // Never "healthy" phrasing. This says the instrument is not reading,
      // which is a different claim from "everything is fine".
      parts.push(
        `Estate health is not being measured${health.reason ? `: ${health.reason}.` : "."}`,
      );
      break;
  }

  if (health.stale) {
    parts.push("This is the last known reading; the current one could not be taken.");
  }

  return parts.join(" ");
}

export function HealthIndicator({
  health,
}: {
  readonly health: EstateHealth;
}): React.JSX.Element {
  const presentation = PRESENTATION[health.state];

  return (
    <span
      // `status` rather than `alert`: this is ambient, and an alert would
      // interrupt a screen reader on every navigation.
      role="status"
      aria-label={describe(health)}
      title={describe(health)}
      className={`flex items-center gap-1.5 text-xs ${presentation.text}`}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${presentation.dot}`} />
      <span className="hidden sm:inline">{presentation.label}</span>
      {health.stale ? <span className="hidden sm:inline">(stale)</span> : null}
    </span>
  );
}
