"use server";

import { changeRepos, type RepoWriteResult } from "@/lib/repos-write";
import type { RepoChange } from "@/lib/repos";

/**
 * Changing repositories, as a server action.
 *
 * A shell, like `platform/tenants/actions.ts`: `lib/repos-write` owns the
 * session, both capability checks, the request and the error mapping, and
 * opens with `import "server-only"`, so the client table cannot import it.
 *
 * No revalidatePath: `GET /v1/repos` is read per request with nothing cached
 * server-side, so the caller runs `router.refresh()` instead.
 */
export async function changeReposAction(names: string[], change: RepoChange): Promise<RepoWriteResult> {
  return changeRepos(names, change);
}
