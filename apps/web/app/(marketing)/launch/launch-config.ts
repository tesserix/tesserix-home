// Shared launch data — imported by the pages, the client countdown and the
// generated Open Graph images so a date can never drift between them.
//
// This module is the single seam for release data. When the admin portal
// grows a "Releases" CRUD (DB-backed), only getLaunchReleases() changes:
// every page, OG card and sitemap entry downstream re-renders from whatever
// it returns. Nothing else in the launch feature knows where the data lives.

export interface LaunchRelease {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly href: string;
  /** UTC instant of the release. */
  readonly targetIso: string;
  /** Human form of targetIso, shown on the page and the OG card. */
  readonly displayDate: string;
  /** Accent is deliberately tiny: the live dot, a soft glow, one OG stripe. */
  readonly dotClass: string;
  readonly glowClass: string;
  readonly accentHex: string;
}

export const LAUNCH_PAGE_URL = "https://tesserix.app/launch";

// Saturday 1 August 2026, 2:00 PM AEST (UTC+10).
const SAT_2PM_AEST_ISO = "2026-08-01T04:00:00.000Z";
const SAT_2PM_AEST_DISPLAY = "Sat 1 Aug 2026 · 2:00 PM AEST";

const RELEASES: readonly LaunchRelease[] = [
  {
    slug: "fe3dr",
    name: "Fe3dr",
    tagline:
      "Real home-cooked food from verified kitchens near you. Ghar ka khana, delivered.",
    href: "/products/fe3dr",
    targetIso: SAT_2PM_AEST_ISO,
    displayDate: SAT_2PM_AEST_DISPLAY,
    dotClass: "bg-amber-500",
    glowClass: "bg-amber-500/10",
    accentHex: "#f59e0b",
  },
  {
    slug: "mark8ly",
    name: "Mark8ly",
    tagline:
      "Quiet commerce for people who make things. Your marketplace, live in days.",
    href: "/products/mark8ly",
    targetIso: SAT_2PM_AEST_ISO,
    displayDate: SAT_2PM_AEST_DISPLAY,
    dotClass: "bg-indigo-500",
    glowClass: "bg-indigo-500/10",
    accentHex: "#6366f1",
  },
];

/** Future admin hook: swap the static list for a DB read here. */
export function getLaunchReleases(): readonly LaunchRelease[] {
  return RELEASES;
}

export function getLaunchRelease(slug: string): LaunchRelease | undefined {
  return RELEASES.find((release) => release.slug === slug);
}

export interface LaunchGroup {
  readonly targetIso: string;
  readonly displayDate: string;
  readonly releases: readonly LaunchRelease[];
}

/**
 * Releases sharing an instant render as one event with a single countdown;
 * a release added later with its own date automatically gets its own section.
 */
export function groupReleasesByTarget(
  releases: readonly LaunchRelease[],
): readonly LaunchGroup[] {
  const groups = new Map<string, LaunchRelease[]>();
  for (const release of releases) {
    const existing = groups.get(release.targetIso);
    if (existing) {
      existing.push(release);
    } else {
      groups.set(release.targetIso, [release]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([targetIso, grouped]) => ({
      targetIso,
      displayDate: grouped[0].displayDate,
      releases: grouped,
    }));
}
