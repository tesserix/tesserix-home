"use server";

import { fetchSecretDetail } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import type { SecretStore } from "@/lib/secrets";

/**
 * The create form's guard against the silent-overwrite trap: a create sends
 * no `ifVersion`, which the store reads as "no concurrency check requested",
 * so writing to a path that already holds a secret would quietly append a
 * version to somebody else's live secret and report it as a creation. This
 * action lets the form check first.
 *
 * A 404 from `fetchSecretDetail` is the ONLY case that means the path is
 * free — every other failure (403, 500, a network error, a malformed
 * response) means "we could not find out", not "it is free", and must come
 * back as `ok: false`, never `exists: false`. Collapsing "unknown" into
 * "false" here would reinstate exactly the overwrite this function exists to
 * prevent: the form would offer to create on top of a path it never actually
 * confirmed was empty.
 *
 * No capability check here: this is a read, and `secrets-api` already gates
 * it on `platform` on the operator's own Zitadel token (the same token
 * `fetchSecretDetail` resolves through `secretsRequest`) — the same gate
 * that sits in front of the write this check precedes. A console-side check
 * here would duplicate that gate rather than add a second layer of defence,
 * which is why `render-path-capabilities.test.ts`'s `GATED_FILES` list —
 * covering server actions and route handlers that gate a WRITE — does not
 * name this file: it gates nothing, it only asks a question ahead of one.
 */
export async function secretExistsAction(
  store: SecretStore,
  path: string,
): Promise<{ ok: true; exists: boolean } | { ok: false; message: string }> {
  try {
    await fetchSecretDetail(store, path);
    return { ok: true, exists: true };
  } catch (cause) {
    if (cause instanceof PlatformApiError && cause.status === 404) {
      return { ok: true, exists: false };
    }
    return {
      ok: false,
      message: cause instanceof PlatformApiError ? cause.message : "Could not check whether this path is already in use.",
    };
  }
}
