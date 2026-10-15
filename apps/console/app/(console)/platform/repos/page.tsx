import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx`'s "use client" turns `resolveState` into a client reference
// that throws when called here. See `platform/tenants/page.tsx`.
import { NOT_IMPLEMENTED, toSurfaceError, type SurfaceError } from "@/components/kit/surface-state";
import { requiresCapability } from "@/lib/internal-access";
import { fetchRepos } from "@/lib/platform-api";
import type { RepoListing } from "@/lib/repos";
import { RepoTable } from "./repo-table";

/**
 * The org's GitHub repositories — visibility, archive state and the security
 * signals GitHub gives us — with bulk visibility and archive changes.
 *
 * Reading is `platform` (the route's gate). Changing is `platform` AND
 * `repo-admin`; the page only decides whether to OFFER the actions, and the
 * action and platform-api each refuse independently.
 */

export const REPOS_UNAVAILABLE_TITLE = "Repositories are not switched on";
export const REPOS_UNAVAILABLE_MESSAGE =
  "The platform API has no GitHub App configured for the organisation. Nothing is broken and " +
  "there is nothing to retry — this surface turns on once the App is installed and its " +
  "REPOS_GITHUB_APP_* settings are deployed.";

/** The read's rejection, with this surface's own 501 copy — the kit default
 *  points at the observability park, which is the wrong remedy here. */
export function repoReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return { ...error, unavailable: { title: REPOS_UNAVAILABLE_TITLE, message: REPOS_UNAVAILABLE_MESSAGE } };
}

export default async function ReposPage() {
  let listing: RepoListing | null = null;
  let error: SurfaceError | null = null;
  try {
    listing = await fetchRepos();
  } catch (caught: unknown) {
    error = repoReadError(caught);
  }

  const session = await getCurrentSession();
  // Each its own check, as `checkOperatorCapability` makes them: `repo-admin`
  // without `platform` is refused by the API, so it must not be offered here.
  const canChange =
    !requiresCapability() ||
    (hasCapability(session?.roles, "platform") && hasCapability(session?.roles, "repo-admin"));

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Repositories"
        description="Every repository in the GitHub organisation, its visibility and its open security alerts."
      />
      <RepoTable listing={listing} error={error} canChange={canChange} />
    </div>
  );
}
