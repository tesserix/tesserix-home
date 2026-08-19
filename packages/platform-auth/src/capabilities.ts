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
  // ---------------------------------------------------------------------
  // ENTRY
  // ---------------------------------------------------------------------
  /**
   * Console entry, and NOTHING else.
   *
   * Reduced to this by #261. It used to mean two things — "may enter the
   * console" and, in practice, "may do almost anything": 11 of 14 mutating
   * server actions were gated on it, including a 500-contact bulk import.
   * `read` now grants the shell and home; every feature surface needs its own
   * surface capability below.
   */
  "read",

  // ---------------------------------------------------------------------
  // SURFACES — which part of the console an operator works in.
  //
  // These say WHERE, never WHAT. Holding `crm` grants the CRM; deleting an
  // organisation still additionally requires `hard-delete`. Seeing a surface
  // and being trusted with its destructive verb are different questions, and
  // keeping them separate is what stops a surface grant quietly carrying a
  // blast radius nobody weighed.
  // ---------------------------------------------------------------------
  /** The CRM: organisations, contacts, opportunities, imports, suppressions. */
  "crm",
  /** Support: the ticket queue, live chat, support analytics. */
  "support",
  /**
   * Billing surfaces: wallets, refunds, payouts, subscription state.
   *
   * RESERVED — the console has no billing surface today (0 of 28 routes), so
   * nothing checks this yet. Declared now so the vocabulary is complete and the
   * Zitadel role exists before a surface needs it, because renaming a
   * capability later silently breaks every assignment while adding one does
   * not. A grant of this currently confers nothing; treat it as a placeholder
   * rather than evidence that a billing surface is gated.
   */
  "billing",
  /**
   * Platform operations: the estate dashboard, apps, health and observability,
   * governance surfaces (audit log, outbox, GDPR queue, break-glass, settings),
   * custom domains and databases.
   *
   * The broadest surface, and deliberately so for now — the risk verbs are what
   * separate reading the uptime board from rotating a live credential. If the
   * governance and health halves ever want different people, this is the one to
   * split first.
   */
  "platform",

  // ---------------------------------------------------------------------
  // VERBS — what may be DONE, orthogonal to surface.
  // ---------------------------------------------------------------------
  /**
   * Reply to tickets and chats, transition their status.
   *
   * A VERB, deliberately kept beside `support` rather than folded into it
   * (#261). The route table already behaves this way: `platform.tickets`
   * carries no `respond` because the queue is genuinely readable, while
   * `platform.liveChat` does because it is opened to reply. Collapsing the two
   * would make "can see the ticket queue" and "can answer a merchant" the same
   * permission.
   */
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

/**
 * The surface capabilities, in declaration order.
 *
 * Exported so a test can assert that no server action or route gates on `read`
 * alone, and so a renderer can reason about surfaces without hard-coding the
 * list. Membership here is what makes a capability a "where" rather than a
 * "what".
 */
export const SURFACE_CAPABILITIES = [
  "crm",
  "support",
  "billing",
  "platform",
] as const satisfies readonly Capability[];

/**
 * The risk verbs, in declaration order.
 *
 * Orthogonal to surfaces by design: a verb layers ON TOP of surface access
 * rather than replacing it. `hard-delete` plus `crm` erases a contact; either
 * alone does not.
 */
export const RISK_CAPABILITIES = [
  "respond",
  "rotate-credentials",
  "adjust-balance",
  "execute-refund",
  "mass-send",
  "hard-delete",
] as const satisfies readonly Capability[];

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
