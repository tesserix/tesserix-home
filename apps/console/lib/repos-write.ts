// `server-only`: this reads the operator's session and their platform API
// token. A client component importing it must fail the build.
import "server-only";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { recordDeniedAttempt } from "@/lib/db/denied-attempts";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { parseRepoChangeResults, type RepoChange, type RepoChangeResult } from "@/lib/repos";

/**
 * Changing repositories' visibility or archived state, through platform-api.
 *
 * Nothing here audits: platform-api writes one row per repository it actually
 * changed, on a transaction that commits only once GitHub has accepted the
 * change (`modules/repos/internal/service`). A console-side row would be a
 * second account of the same event that disagrees the first time a batch
 * half-succeeds — which, with no bulk endpoint on GitHub, batches do.
 */
export type RepoWriteResult =
  | { ok: true; results: RepoChangeResult[] }
  | { ok: false; message: string };

const NO_PERMISSION =
  "You do not have permission to change repositories. It needs the platform surface and the repo-admin capability.";

/** Deliberately not "nothing changed" — see `tenant-lifecycle-write.ts`'s
 *  NOT_APPLIED for why a lost answer cannot be read as a refusal. */
const NOT_CONFIRMED =
  "The change could not be confirmed. Reload the list to see each repository's current state before trying again.";

export async function changeRepos(names: readonly string[], change: RepoChange): Promise<RepoWriteResult> {
  const session = await getCurrentSession();
  try {
    // Checked here as well as by the API, which remains the authorisation
    // boundary: this stops the console sending a request it knows will be
    // refused, and makes the refusal read as a permission rather than a fault.
    await checkOperatorCapabilityLive(session, "platform");
    await checkOperatorCapabilityLive(session, "repo-admin");

    const [path, body] =
      change.kind === "archive"
        ? ["/v1/repos/archive", { repos: names, archived: change.archived }]
        : [
            "/v1/repos/visibility",
            {
              repos: names,
              visibility: change.visibility,
              ...("windowHours" in change ? { window_hours: change.windowHours } : {}),
              ...("permanent" in change ? { permanent: true } : {}),
            },
          ];
    const response = await platformRequestWithMeta("repos", path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: true, results: parseRepoChangeResults(response.data) };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      await recordDeniedAttempt({
        actor: session?.sub ?? session?.email ?? "unknown",
        required: cause.required,
        target: `repos ${change.kind} ${names.join(",")}`.slice(0, 200),
        kind: "verb",
      });
      return { ok: false, message: NO_PERMISSION };
    }
    if (cause instanceof PlatformApiError) {
      if (cause.status === 403) return { ok: false, message: NO_PERMISSION };
      if (cause.status === 501) {
        return { ok: false, message: "Repository changes are not switched on: no GitHub App is configured." };
      }
      if (cause.status === 400 || cause.status === 422) {
        // A malformed request is the console's bug, and nothing was sent to
        // GitHub — the API validates the whole batch before touching one repo.
        return { ok: false, message: "The request was refused before anything was changed." };
      }
    }
    return { ok: false, message: NOT_CONFIRMED };
  }
}
