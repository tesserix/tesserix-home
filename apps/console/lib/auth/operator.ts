// `server-only`: the live gate below reads Postgres and can call Zitadel. A
// client component that reaches it must fail the build loudly, naming the
// import chain, rather than dragging `pg` into the browser bundle.
import "server-only";

import {
  CapabilityError,
  hasCapability,
  type Capability,
} from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";
import {
  resolveLiveCapabilities,
  type CapabilitySession,
} from "@/lib/auth/platform-token";

/**
 * The console's verb gate: every server action that mutates state calls this
 * before doing anything else.
 *
 * Provider-gated exactly like `isInternal` and for the same reason — legacy
 * google sessions carry no roles claim, so requiring one under that provider
 * would refuse every write in local dev. A missing session is refused
 * unconditionally: middleware already gates the route, but a verb must fail
 * closed on its own rather than inherit safety from routing.
 *
 * # THIS ONE READS THE COOKIE, AND THAT IS NOT THE CONTROL
 *
 * The cookie's `roles` claim is a SNAPSHOT taken at login and carried for the
 * seven days that session lives. It is the right input for deciding which
 * buttons to render — the render path calls `hasCapability(session?.roles, …)`
 * directly and should keep doing so — and it is the wrong input for deciding
 * whether a mutation may proceed, because a grant revoked in Zitadel an hour
 * ago is still in it (tesserix-home#285).
 *
 * KEPT, deliberately, and not deprecated: it is the synchronous, I/O-free
 * predicate, and the async gate below is written in terms of the same
 * semantics. New mutating call sites want
 * {@link checkOperatorCapabilityLive}.
 */
export function checkOperatorCapability(
  session: { roles?: readonly string[]; email?: string } | null,
  required: Capability,
  provider: string | undefined = process.env.AUTH_PROVIDER,
): void {
  if (!session) {
    throw new CapabilityError(required);
  }
  if (!requiresCapability(provider)) {
    return;
  }
  // No allowlist short-circuit. It used to sit here, and it made this check a
  // no-op for exactly the identities that can reach every write: an
  // allowlisted email returned before any capability was consulted. With
  // capabilities now derived from the Zitadel grant rather than from list
  // membership (see `capabilitiesFor`), keeping it would preserve the old
  // behaviour on the mutation path while the read path enforced the new one —
  // the worst of both, and invisible until someone tested a write.
  if (!hasCapability(session.roles, required)) {
    throw new CapabilityError(required);
  }
}

/** What the live gate needs: the sync gate's inputs, plus what identifies the
 *  server-side row. `sub` and `sid` come from the same verified session claims
 *  the cookie already carries. */
export type LiveCapabilitySession = CapabilitySession & {
  roles?: readonly string[];
};

/**
 * The same verb gate, decided against the SERVER-SIDE capability list.
 *
 * # Why this is the one that is the control
 *
 * `docs/PLATFORM-API-CONVENTIONS.md` says "the API is the authorisation
 * boundary; the console's checks are UX on top of it", and that is true for
 * every federated surface. It is NOT true for CRM, tools and tenants: the
 * console writes those to its own Postgres directly, and no platform-api check
 * stands behind them. For those writes this function is the only control there
 * is, which is why it — and not the render-path checks — is what was made
 * live.
 *
 * # The order is the sync gate's order, unchanged
 *
 *  1. No session → refuse. Middleware already gated the route; a verb still
 *     fails closed on its own.
 *  2. `!requiresCapability(provider)` → allow. Legacy google sessions carry no
 *     roles at all, so requiring one would refuse every write in local dev.
 *  3. Otherwise consult the store, revalidating it if stale.
 *
 * THERE USED TO BE A STEP BETWEEN 2 AND 3: `isPlatformOperator(email)` →
 * allow, on the reasoning that the allowlist is the estate's door and holds
 * every capability by construction. The second half of that stopped being
 * true — capabilities now come from the Zitadel grant (`capabilitiesFor`), so
 * the door no longer hands over every key — and a bypass that outlives its
 * justification is worse than no bypass: it made this check a no-op for
 * exactly the identities that can reach every write.
 *
 * ONLY STEP 2 SHORT-CIRCUITS BEFORE I/O NOW, and the cost of that is real and
 * accepted: both operators on the allowlist used to take the removed step, so
 * the mutation path touched neither Postgres nor Zitadel for them. Every gated
 * write by those operators now reads the capability store, and revalidates
 * against Zitadel when the row is stale. That is the price of the store being
 * the authority — and it is what makes a revocation reach the two identities
 * it previously could not (#285).
 *
 * # A REVOCATION REFUSES THE ACTION AND KEEPS THE SESSION
 *
 * There is no forced sign-out here, deliberately. The grant that surfaced #285
 * was an ADDITION, and booting someone because a capability changed would make
 * an ordinary IdP edit an outage for whoever was mid-task. The action fails
 * with the same `CapabilityError` any other refusal raises; the session stays.
 *
 * # WHEN THERE IS NO LIVE ANSWER, THE COOKIE DECIDES — STATED AND ACCEPTED
 *
 * If the store is unreachable, or the refresh fails, or Zitadel is down, this
 * falls back to the cookie's snapshot and logs at WARN. That WIDENS the
 * revocation window back towards the session lifetime for as long as the
 * outage lasts, and that is the accepted trade rather than an oversight:
 *
 *  - Refusing every gated action during a database blip or an IdP outage is
 *    its own outage, and a worse one — it takes the console's entire mutation
 *    surface down for a fault unrelated to authorization.
 *  - The cookie's grant is not unattested. It is issuer-signed, verified at
 *    login, and merely STALE. Falling back to it is falling back to the exact
 *    behaviour that shipped before this change, for the duration of a fault.
 *
 * The WARN is what makes the widened window visible; a fallback nobody can see
 * in the logs is the shape of thing that becomes permanent by accident.
 */
export async function checkOperatorCapabilityLive(
  session: LiveCapabilitySession | null,
  required: Capability,
  provider: string | undefined = process.env.AUTH_PROVIDER,
): Promise<void> {
  if (!session) {
    throw new CapabilityError(required);
  }
  if (!requiresCapability(provider)) {
    return;
  }
  // The allowlist short-circuit that used to sit here is gone with its
  // synchronous twin, and its removal has a cost worth naming: both operators
  // on the allowlist took it, so the live path did no I/O at all for them.
  // Every gated write by an allowlisted operator now reads the capability
  // store, and revalidates against Zitadel when that row is stale. That is the
  // price of the store being the authority — and it is what makes a revocation
  // actually take effect for these operators rather than only for everyone
  // else (#285).
  const resolved = await resolveLiveCapabilities(session);
  if (resolved.source === "unavailable") {
    // `no-sid` is an ordinary fact, not a fault: a session minted before the
    // token store existed has no row and never will. Warning on it would fire
    // for every such session for seven days after any deploy and train
    // everyone to ignore the line that matters.
    if (resolved.reason !== "no-sid") {
      console.warn(
        "[auth] no live capability answer; falling back to the session's snapshot",
        { reason: resolved.reason, required },
      );
    }
    if (!hasCapability(session.roles, required)) {
      throw new CapabilityError(required);
    }
    return;
  }

  // THE STORE DECIDES, AND THE COOKIE IS NOT CONSULTED. Not an `||` with the
  // snapshot, in either direction: a capability the cookie carries and the
  // store does not is exactly the revocation #285 is about and must be
  // REFUSED, and one the store carries and the cookie does not is the
  // 2026-08-19 grant that had to wait for a re-login and must be ALLOWED.
  if (!hasCapability(resolved.capabilities, required)) {
    throw new CapabilityError(required);
  }
}
