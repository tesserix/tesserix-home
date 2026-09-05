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
   * NO LONGER RESERVED. `platform.billing` gates on this — the estate's §8.2
   * surface, its recurring plans and expiring trials — so a grant now confers
   * real access rather than nothing.
   *
   * It was reserved from the day the vocabulary was written, on the reasoning
   * that renaming a capability later silently breaks every assignment while
   * adding one does not. That bet paid: the surface arrived and the role
   * already existed.
   *
   * What a grant means, stated because it is broader than it looks: §7 records
   * that capabilities are estate-wide, not per-product. So this opens EVERY
   * product's revenue, not a chosen one. There is no way to express "may see
   * mark8ly's billing but not Kora's" today.
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
  /**
   * Publish the plan catalog to Stripe — create, replace or archive Prices.
   *
   * NOT `rotate-credentials`, which already covers "payment-gateway keys,
   * Stripe settings": holding a credential verb should not imply the ability
   * to change what customers are charged. Different blast radius, different
   * grant.
   *
   * DEPLOY PRECONDITION: these strings are a contract with Zitadel. The role
   * must exist on the Platform Console project AND be assigned before this
   * ships, or publishing is dead for every operator — including whoever
   * deployed it — with a CapabilityError that names no cause.
   */
  "publish-catalog",

  // ---------------------------------------------------------------------
  // MACHINE — held by a service identity, not an operator.
  //
  // Neither a surface nor a verb: a machine enters no console session and
  // works in no surface, so SURFACE_CAPABILITIES' "where an operator works"
  // and RISK_CAPABILITIES' operator-verb framing both describe a concept
  // this identity doesn't have. Forcing it into either list would misstate
  // what it is rather than clarify it.
  // ---------------------------------------------------------------------
  /**
   * Read the PUBLISHED plan catalog. Held by a Zitadel service user (a
   * machine), never an operator.
   *
   * Grants reading published prices and nothing else — not `billing`'s
   * wallets, refunds, payouts and subscription state. A machine created to
   * read prices must not thereby hold the console's entire billing surface;
   * that is the entire reason this capability exists rather than reusing
   * `billing`. It deliberately does not imply, and is not implied by,
   * `billing` or any other capability here.
   *
   * DEPLOY PRECONDITION, same shape as `publish-catalog`: this string is a
   * contract with Zitadel. The role must exist and be granted to the
   * service user before the read endpoint ships, or verification succeeds
   * while authorization silently fails for every caller.
   */
  "read-plan-catalog",

  /**
   * Read the promo-code catalog — the definitions a product's onboarding
   * redeems (tesserix-home#521). Held by a Zitadel service user, never an
   * operator.
   *
   * SEPARATE FROM `read-plan-catalog`, and not implied by it. The two
   * contracts answer different questions and a machine may legitimately need
   * one without the other: a redeemer that only extends trials never reads a
   * price, and the price reader that mark8ly runs today has no business
   * enumerating every promo code in the estate. Folding this into
   * `read-plan-catalog` would silently widen a grant already made, which is
   * the one direction a capability must never move on its own.
   *
   * DEPLOY PRECONDITION, same shape as `read-plan-catalog`: this string is a
   * contract with Zitadel. The role must exist on the Platform Console
   * project AND be granted to the service user before a caller can use the
   * endpoint — until then verification succeeds and authorization answers
   * 403, which is the correct answer and not a bug in the route.
   */
  "read-promo-catalog",

  /**
   * Reach a product's OWN support tickets — file, read, and reply to them
   * (tesserix-home#152). Held by a Zitadel service user, never an operator.
   *
   * NOT `support`. That is an operator SURFACE, and §7 records that
   * capabilities are estate-wide rather than per-product: granting `support`
   * to a product's machine would open every other product's ticket queue, and
   * `respond` beside it would open replying to and re-statusing them. mark8ly
   * needs its own merchants' tickets and nothing else, and there was no
   * capability that said so — which is why this one exists rather than
   * reusing the operator pair.
   *
   * WHICH product a holder may reach is deliberately NOT encoded here. A
   * capability string cannot carry a product — §7 again — and inventing
   * `product-support:mark8ly` would put a per-product dimension into a
   * vocabulary that is a fixed contract with Zitadel's role list, where
   * `toCapabilities` drops anything it does not already know. Scope comes
   * from the subject->product registry instead: this capability answers
   * WHETHER, the registry answers WHICH, and a holder absent from the
   * registry is refused rather than defaulted.
   *
   * It is emphatically not derived from `Principal.Kind`, which
   * `platform-auth/verify.go` forbids authorising on — classification and
   * access are kept apart so that changing one cannot silently change the
   * other (#450, #433).
   *
   * DEPLOY PRECONDITION, same shape as `read-plan-catalog`: this string is a
   * contract with Zitadel. The role must exist on the Platform Console
   * project AND be granted to the service user before the gated routes ship,
   * or verification succeeds and authorization answers 403 to every caller —
   * which is the correct answer, and not a bug in the route.
   */
  "product-support",

  /**
   * Read the PUBLISHED platform announcements addressed to a product
   * (tesserix-home#152). Held by a Zitadel service user, never an operator.
   *
   * SEPARATE from `product-support`, on the same reasoning that keeps
   * `read-promo-catalog` out of `read-plan-catalog`: the two answer different
   * questions and a machine may legitimately need one without the other. A
   * product that shows a maintenance banner has no business reading its
   * merchants' support tickets, and folding the two together would widen a
   * grant already made.
   *
   * WHICH product's announcements a holder sees is not encoded here — it comes
   * from the subject->product registry, exactly as it does for tickets.
   *
   * DEPLOY PRECONDITION, same shape as the other machine capabilities: the
   * role must exist on the Platform Console project AND be granted before the
   * route ships, or it answers 403 to every caller.
   */
  "read-announcements",
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
  "publish-catalog",
] as const satisfies readonly Capability[];

/**
 * Capabilities held by a machine identity (a Zitadel service user), never an
 * operator.
 *
 * A third bucket, not a subset of SURFACE_CAPABILITIES or RISK_CAPABILITIES:
 * those two describe an operator's console — where they work, what they may
 * do there. A machine does neither. Keeping this list separate is what lets
 * `hasCapability`/`toCapabilities` stay a single shared check while still
 * letting a reviewer see, at a glance, which strings a human should never be
 * granted for console access alone.
 */
export const MACHINE_CAPABILITIES = [
  "read-plan-catalog",
  "read-promo-catalog",
  "product-support",
  "read-announcements",
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
 * boolean check silently grants access, whereas a forgotten check of any kind
 * is caught by `apps/console/lib/capability-coverage.guard.test.ts`, which
 * walks every `"use server"` module and fails when one neither calls a gate
 * nor delegates to a module that does.
 *
 * THAT CHECK NOW EXISTS. This comment previously claimed "the route-coverage
 * CI check", and there was none — the guarantee was asserted and not provided,
 * which is what #264 was filed to correct. It is named here rather than
 * described, so the next reader can open it.
 */
export function assertCapability(
  held: readonly string[] | undefined | null,
  required: Capability,
): void {
  if (!hasCapability(held, required)) {
    throw new CapabilityError(required);
  }
}
