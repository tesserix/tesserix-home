// Pure guards for the user detail page's delete flow, split out of
// delete-user.tsx so they are directly testable — vitest.config.ts's
// `include` is `app/**/*.test.ts` (glob-exact, does not match `.test.tsx`),
// same constraint already documented in ../format.ts. delete-user.tsx is a
// "use client" component driven by hooks; it is never unit tested directly
// in this repo (feedback-table.tsx and food-form.tsx follow the same
// pattern), so any logic worth pinning has to live here instead.

import type { KoraDeleteResult, KoraTransfer } from "@/lib/api/kora-admin";

/**
 * Exact match, deliberately NOT case-folded and NOT trimmed. This is the
 * last gate before an irreversible action with no grace period — the point
 * is that the operator reads the address and reproduces it deliberately, not
 * that a "close enough" match satisfies the guard. An empty `email` (which
 * should never happen, but the type doesn't forbid it) must never be
 * satisfiable by an empty `typed` value.
 */
export function canDelete(email: string, typed: string): boolean {
  return email.length > 0 && typed === email;
}

/**
 * A surviving Firebase identity means the deleted person can still sign in;
 * EnsureUser then provisions a fresh empty account and the user the admin
 * just deleted REAPPEARS. Returns null when the identity was actually
 * removed, so the confirmation UI shows nothing extra on the clean path —
 * the API reports this precisely so the operator is never told the deletion
 * was complete when it was not.
 */
export function postDeleteWarning(r: KoraDeleteResult): string | null {
  if (r.firebase_identity_removed) return null;
  return (
    "Account data was deleted, but the Firebase identity survived — this person can still sign in, " +
    "which will create a new empty account. Remove the identity in the Firebase console."
  );
}

/**
 * One line per transfer for the pre-delete warning list, e.g. `Runners
 * (group) transfers to a1b2c3d4-...`. `new_owner_id` is a raw UUID from the
 * API — no owner-name lookup exists on this surface, so it renders in full
 * rather than silently truncating an identifier an operator may need to
 * paste elsewhere (e.g. into this same page to look the new owner up).
 */
export function transferLine(t: KoraTransfer): string {
  return `${t.name} (${t.kind}) transfers to ${t.new_owner_id}`;
}
