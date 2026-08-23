import type { EstateHealth, HealthState } from "@/lib/health";

/**
 * The estate health's shared presentation: shape, colour, and accessible
 * wording.
 *
 * # Why this lives apart from the indicator
 *
 * Two surfaces show this state: the header indicator (`components/nav/
 * health-indicator.tsx`) and the health page (`app/(console)/platform/
 * health/page.tsx`). Both need to agree on what "degraded" looks like — a
 * diamond, amber, "Degraded" — and on what it SAYS. Restating the mapping in
 * each surface is exactly the drift this codebase has already paid for once
 * (see the indicator's own history); extracting it here means there is one
 * place to get it right and one place a reviewer needs to check.
 */

export interface HealthPresentation {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
}

// The console's own semantic tokens — NOT another app's palette. These carry
// the console's dark mode for free, which hardcoded values would not.
//
// # The three SHAPES are load-bearing — do not tidy them into three circles
//
// Three same-sized circles differing only in hue is colour-alone information
// (WCAG 2.1 AA, 1.4.1) and unreadable to a red/green-deficient operator —
// exactly the reader who most needs it. Filled circle / rotated square (a
// diamond) / hollow ring stay distinct in monochrome and at small sizes.
export const HEALTH_PRESENTATION: Record<HealthState, HealthPresentation> = {
  healthy: {
    label: "Healthy",
    dot: "size-2 rounded-full bg-success",
    text: "text-muted-foreground",
  },
  degraded: {
    label: "Degraded",
    dot: "size-2 rotate-45 bg-warning",
    text: "text-foreground",
  },
  unmeasured: {
    // A hollow RING, not a filled dot. Unmeasured differs from healthy in
    // SHAPE as well as colour, so it stays distinguishable to a colour-blind
    // reader and in a monochrome rendering. This is the whole point of the
    // third state and must not be softened into a paler green.
    label: "Unmeasured",
    dot: "size-2 rounded-full border border-muted-foreground bg-transparent",
    text: "text-muted-foreground",
  },
};

/**
 * The full accessible sentence for a health reading — what a screen reader
 * announces for the indicator, and what the health page renders as text.
 */
export function describeHealth(health: EstateHealth): string {
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
    // The RAW ISO string, deliberately. A relative age ("40 seconds ago")
    // reads the clock, and a locale-formatted time reads the locale; this
    // renders on the server and hydrates on the client, so either one is a
    // hydration mismatch. The timestamp is what tells an operator whether the
    // reading is 20 seconds old or about to be abandoned as unmeasured.
    parts.push(
      health.checkedAt
        ? `This is the last known reading, taken at ${health.checkedAt}; the current one could not be taken.`
        : "This is the last known reading; the current one could not be taken.",
    );
  }

  return parts.join(" ");
}
