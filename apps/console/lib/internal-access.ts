import { isPlatformOperator } from "@tesserix/platform-auth";

/**
 * Is this session an internal operator's?
 *
 * Under `zitadel` the allowlist in `operators.ts` is the whole gate: it admits
 * on email alone, and a role grant is neither necessary nor sufficient. Before
 * cutover sessions carry no roles at all, so `google` accepts them unchanged
 * rather than locking every operator out on deploy.
 */
export function requiresCapability(
  provider: string | undefined = process.env.AUTH_PROVIDER,
): boolean {
  return provider === "zitadel";
}

/** `roles` is accepted and ignored — the allowlist decides, grants do not. */
export function isInternal(
  roles: readonly string[] | undefined,
  provider: string | undefined = process.env.AUTH_PROVIDER,
  email?: string | null,
): boolean {
  if (!requiresCapability(provider)) return true;
  return isPlatformOperator(email);
}

/**
 * The value of `CONSOLE_RBAC_ENFORCEMENT` that turns route enforcement OFF.
 *
 * A word rather than a boolean-ish string: `false`/`0`/`no` all invite a
 * parser, and a parser is what turns a typo into "enforcement silently off".
 * Anything that is not exactly this is treated as "leave it on", so a
 * mistyped value fails in the safe direction.
 */
const ENFORCEMENT_OFF = "off";

/**
 * May the console refuse a surface the operator does not hold? (#266, R6.2)
 *
 * A KILL SWITCH, NOT A TOGGLE. It can only ever DISABLE enforcement; it can
 * never enable it where capability claims do not exist. The asymmetry is the
 * point:
 *
 *   - `requiresCapability(provider)` still has to be true. Under the legacy
 *     provider a session carries no capability claims at all, and both filters
 *     (`visibleNav`, `visibleTo`) fail closed — so an "on" that ignored the
 *     provider would refuse every surface to every operator, which is the
 *     exact lockout this switch exists to undo.
 *   - The flag can only subtract. So the worst a wrong value can do is leave
 *     enforcement on, which is today's behaviour.
 *
 * UNSET MEANS UNCHANGED, deliberately: merging this cannot alter what any
 * operator can reach. That is the property `requiresCapability` was built with
 * at the Zitadel cutover — "merging changes nothing" — and #266 names it as
 * the precedent to follow.
 *
 * WHY IT EXISTS. #262's gate fails closed with no wildcard and no superuser,
 * and refuses with a 404 that is deliberately indistinguishable from "never
 * built". So a grant narrowed by mistake removes an operator's access with no
 * signal about why and no way back except a redeploy. This is the way back:
 * set `CONSOLE_RBAC_ENFORCEMENT=off` on the deployment, and the console
 * returns to admitting anyone who can enter while the grant is repaired.
 *
 * IT IS MEANT TO BE REMOVED. #266's step 7 retires it once grants have settled
 * — a permanent bypass of the check the console exists to perform is exactly
 * what `internal-access.ts` already warns about for the `google` branch of
 * `requiresCapability`. The condition for removing it is written down in
 * docs/RBAC-CAPABILITIES.md rather than left to memory.
 */
export function enforcesRouteCapabilities(
  provider: string | undefined = process.env.AUTH_PROVIDER,
  flag: string | undefined = process.env.CONSOLE_RBAC_ENFORCEMENT,
): boolean {
  if (!requiresCapability(provider)) return false;
  return flag?.trim().toLowerCase() !== ENFORCEMENT_OFF;
}
