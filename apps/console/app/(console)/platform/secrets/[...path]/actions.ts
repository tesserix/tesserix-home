"use server";

import { writeSecret } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import type { SecretStore } from "@/lib/secrets";

/**
 * `write-secret-form.tsx`'s only door into `writeSecret`.
 *
 * `lib/secrets-api.ts` carries a `server-only` import specifically so a
 * `"use client"` module reaching it fails the BUILD rather than shipping the
 * operator-token store (and, through it, `pg`) into the browser bundle — see
 * that file's own header. `write-secret-form.tsx` is a client component (it
 * holds the generated/typed value in React state), so it cannot import
 * `writeSecret` directly; this "use server" action is the boundary the form
 * calls across instead, exactly the shape `draft-editor.tsx` uses for
 * `setAmountAction` in the billing catalog.
 *
 * No capability check here: `secrets-api` itself gates the write at the verb
 * (task-5-brief.md's own words — "The API refuses regardless"), so this
 * action's only job is to make the call and turn its failure into a message
 * a form can show. Task 5's page-level gate is about not OFFERING a control
 * that cannot succeed, not about security — the security boundary is the
 * API's, and duplicating it here would just be a second copy to keep in
 * sync with the first.
 */
export type WriteSecretActionResult =
  | { ok: true; version: number }
  | { ok: false; message: string };

function describeFailure(cause: unknown): string {
  if (cause instanceof PlatformApiError) {
    // 409 is `ifVersion`'s whole point (see `writeSecret`'s doc comment):
    // the secret changed since this form last read a version. That is an
    // operator-actionable fact with a clear next step, not a generic
    // failure — worth its own copy rather than falling into `.message`,
    // which here would read as "write secret: secrets-api returned 409"
    // (accurate, but not a sentence an operator can act on).
    if (cause.status === 409) {
      return "This secret changed since this page loaded — reload it and try again.";
    }
    return cause.message;
  }
  return "The value was not saved.";
}

export async function writeSecretAction(
  store: SecretStore,
  path: string,
  data: Record<string, string>,
  ifVersion?: number,
): Promise<WriteSecretActionResult> {
  try {
    const result = await writeSecret(store, path, data, ifVersion);
    return { ok: true, version: result.version };
  } catch (cause) {
    return { ok: false, message: describeFailure(cause) };
  }
}
