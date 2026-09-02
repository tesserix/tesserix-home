/**
 * Who runs the platform console.
 *
 * The capability model in `capabilities.ts` answers "what may this operator
 * do", and Zitadel answers it with project role grants. That leaves one gap
 * this module closes: the console is unusable — 403 at the door — for a real
 * operator whose grant is missing, which is a state the estate can reach by an
 * ordinary IdP mistake and cannot recover from through the console itself.
 *
 * So the estate's own operators are named here rather than only in Zitadel,
 * and since 2026-08-20 this list is the whole door: it admits on email alone
 * and nothing else admits at all, so a stray grant cannot let anyone else in.
 */

import { CAPABILITIES, toCapabilities, type Capability } from "./capabilities";

/** The operators the console exists for, when no override is configured. */
export const DEFAULT_PLATFORM_OPERATOR_EMAILS: readonly string[] = [
  "samyak.rout@gmail.com",
  "mahesh.sangawar@gmail.com",
];

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The configured allowlist.
 *
 * `PLATFORM_OPERATOR_EMAILS` REPLACES the default rather than extending it, so
 * the deployed list is always readable in one place — a list that is partly in
 * code and partly in env is a list nobody can audit.
 */
export function platformOperatorEmails(
  raw: string | undefined | null = process.env.PLATFORM_OPERATOR_EMAILS,
): readonly string[] {
  const configured = (raw ?? "")
    .split(",")
    .map(normalise)
    .filter((email) => email.length > 0);
  return configured.length > 0 ? configured : DEFAULT_PLATFORM_OPERATOR_EMAILS;
}

export function isPlatformOperator(
  email: string | undefined | null,
  raw?: string | undefined | null,
): boolean {
  if (!email) return false;
  return platformOperatorEmails(raw).includes(normalise(email));
}

/**
 * The capabilities a session should carry: exactly what the identity provider
 * granted, narrowed to the known vocabulary.
 *
 * The allowlist is the DOOR, and only the door. It used to be the door and the
 * keys — an allowlisted address returned every capability by construction —
 * and that made two things impossible at once:
 *
 *  - least privilege for anyone who can reach the console at all, since entry
 *    and omnipotence were the same fact;
 *  - the propose-only operator the secrets surface was built for. An operator
 *    holding `platform` without `rotate-credentials` could not exist, so the
 *    console never rendered the propose path (#506) and the notification that
 *    tells a proposer their request merged had no possible recipient (#483).
 *    Both shipped, tested, and were unreachable in production.
 *
 * Entry is deliberately NOT widened to compensate. `isPlatformOperator` still
 * gates the callback, because a role grant must not by itself mint a console
 * operator — whoever administers the Zitadel project would otherwise be able
 * to admit themselves. Two independent grants are now required to get power
 * here: the allowlist for the door, a Zitadel role for each capability.
 *
 * ACCEPTED CONSEQUENCE, stated rather than discovered later: an allowlisted
 * operator whose project grant is missing now signs in able to do nothing,
 * where before they signed in able to do everything. That is the safer
 * direction of the two, but it is a real change — a lost grant reads as a
 * broken console rather than as a permissions problem.
 */
export function capabilitiesFor(
  email: string | undefined | null,
  roles: readonly string[] | undefined | null,
  raw?: string | undefined | null,
): Capability[] {
  // A missing roles claim is "no capabilities", not a crash. The allowlist
  // branch used to return before `roles` was ever read, so an absent claim was
  // survivable for exactly the identities most likely to have one; removing
  // that branch put this call on the path of every sign-in, where a throw
  // would surface as a 500 from the auth callback rather than as a refusal.
  // `hasCapability` already treats absent and empty the same way.
  if (!roles) return [];
  return toCapabilities(roles);
}
