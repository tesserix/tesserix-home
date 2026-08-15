/**
 * Capabilities — what a signed-in operator is allowed to DO.
 *
 * The estate's admin surfaces have, until now, had exactly one authorization
 * level: "holds a valid session". Every operator on the login allowlist could
 * rotate live payment-gateway keys, adjust merchant wallet balances, execute
 * refunds and fire irrevocable mass campaigns. This module is the vocabulary
 * that replaces that single level.
 *
 * Capabilities are named individually and never collapsed into one `admin`
 * flag. "Can read the ticket queue" and "can rotate live Stripe keys" must not
 * be the same permission, because the blast radius is not the same.
 *
 * The strings here are a CONTRACT with Zitadel: they are the role keys defined
 * on the `Platform Console` project, and they arrive verbatim in the
 * `urn:zitadel:iam:org:project:roles` token claim. Renaming one silently breaks
 * every existing role assignment — the token simply stops carrying it — so
 * treat them as immutable once assigned.
 */

export const CAPABILITIES = [
  /** Entry ticket. Every internal operator holds this; nobody else does. */
  "read",
  /** Reply to tickets and chats, transition their status. */
  "respond",
  /** Payment-gateway keys, Stripe settings, break-glass rotation. */
  "rotate-credentials",
  /** Credit or debit a merchant wallet. */
  "adjust-balance",
  /** Execute refunds; release, withhold or reverse payouts. */
  "execute-refund",
  /** Campaigns, announcements, template test-sends. Irrevocable once sent. */
  "mass-send",
  /** Hard delete: leads, users, tenant archival. */
  "hard-delete",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The capability every internal user must hold to reach the console at all. */
export const CONSOLE_ENTRY_CAPABILITY: Capability = "read";

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Narrow arbitrary role strings from a token to known capabilities.
 *
 * Unknown roles are DROPPED rather than carried through. A role we do not
 * recognise cannot be checked meaningfully, and keeping it invites code
 * elsewhere to match on a string this module never sanctioned.
 */
export function toCapabilities(roles: readonly string[]): Capability[] {
  return roles.filter(isCapability);
}

/**
 * Does this set of capabilities include the one required?
 *
 * Fails closed on every degenerate input: undefined, empty, or a capability
 * that is not in `CAPABILITIES`. There is deliberately no wildcard, no
 * superuser short-circuit and no "if none are set, allow" fallback — those are
 * the shapes that turn an authorization check into decoration.
 */
export function hasCapability(
  held: readonly string[] | undefined | null,
  required: Capability,
): boolean {
  if (!held || held.length === 0) return false;
  if (!isCapability(required)) return false;
  return held.includes(required);
}

/** Thrown when an operator lacks the capability a surface requires. */
export class CapabilityError extends Error {
  readonly required: Capability;

  constructor(required: Capability) {
    super(`missing capability: ${required}`);
    this.name = "CapabilityError";
    this.required = required;
  }
}

/**
 * Assert a capability, throwing if absent.
 *
 * Use at the top of any route handler or server action that mutates state.
 * Throwing rather than returning a boolean is deliberate: a forgotten `if` on a
 * boolean check silently grants access, whereas a forgotten `assert` call is
 * caught by the route-coverage CI check.
 */
export function assertCapability(
  held: readonly string[] | undefined | null,
  required: Capability,
): void {
  if (!hasCapability(held, required)) {
    throw new CapabilityError(required);
  }
}
