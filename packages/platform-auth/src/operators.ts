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
 * The capabilities a session should carry.
 *
 * An allowlisted operator holds every capability; everyone else holds exactly
 * what the identity provider granted, narrowed to the known vocabulary.
 */
export function capabilitiesFor(
  email: string | undefined | null,
  roles: readonly string[],
  raw?: string | undefined | null,
): Capability[] {
  if (isPlatformOperator(email, raw)) return [...CAPABILITIES];
  return toCapabilities(roles);
}
