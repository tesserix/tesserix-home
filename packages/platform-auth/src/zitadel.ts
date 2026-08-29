/**
 * Zitadel OIDC — verifying identity and reading roles.
 *
 * Zitadel runs at `auth.tesserix.app` and is the estate's identity platform.
 * This module does two things: it VERIFIES an ID token against Zitadel's JWKS,
 * and it extracts the operator's project roles from it.
 *
 * Verification matters here in a way it did not for the Google flow it
 * replaces. `apps/web`'s `decodeIdTokenUnsafe` skips signature checking, and
 * documents why that is defensible: the token was just exchanged over TLS with
 * Google, so the channel is trusted rather than the token. That reasoning holds
 * for a token you fetched yourself one function call ago. It does NOT hold once
 * the token carries authorization data — roles that decide whether someone may
 * rotate live payment keys must be cryptographically attributable, not merely
 * well-formed. So this path verifies.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { bearerToken } from "./bearer";

/**
 * Zitadel's role claim. Shaped as:
 *
 *   { "read": { "<orgId>": "<orgDomain>" }, "respond": { ... } }
 *
 * The keys are the role keys defined on the project; the values map the
 * granting organization's id to its primary domain. We care about the keys,
 * and — for the internal-user check — about which org granted them.
 *
 * NOTE: this claim is absent from `claims_supported` in the discovery
 * document. Zitadel adds it only when the project asserts roles AND the
 * application is configured to put user roles in the ID token. If both are not
 * set, the token verifies perfectly and carries no roles at all, which
 * presents as an application bug rather than a configuration gap.
 */
const ROLES_CLAIM = "urn:zitadel:iam:org:project:roles";

/** The organization a token's subject belongs to. */
const ORG_ID_CLAIM = "urn:zitadel:iam:org:id";

export interface ZitadelConfig {
  /** Issuer origin, e.g. `https://auth.tesserix.app`. */
  readonly issuer: string;
  /** OIDC client id of the `apps/web` application. */
  readonly clientId: string;
  /**
   * Organization id that denotes an INTERNAL user. Optional: when unset, org
   * is not checked and role possession alone gates access.
   */
  readonly internalOrgId?: string;
}

export function getZitadelConfig(): ZitadelConfig {
  const issuer = process.env.ZITADEL_ISSUER;
  if (!issuer) throw new Error("ZITADEL_ISSUER is not set");
  const clientId = process.env.ZITADEL_CLIENT_ID;
  if (!clientId) throw new Error("ZITADEL_CLIENT_ID is not set");
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    internalOrgId: process.env.ZITADEL_INTERNAL_ORG_ID || undefined,
  };
}

/**
 * JWKS clients are cached per issuer. `createRemoteJWKSet` keeps its own key
 * cache and handles rotation by refetching on unknown `kid`; building a new one
 * per request would defeat that and hammer the issuer on every login.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(issuer);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(`${issuer}/oauth/v2/keys`));
  jwksCache.set(issuer, set);
  return set;
}

export interface ZitadelIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  /** Raw role keys from the token. Narrow with `toCapabilities`. */
  readonly roles: readonly string[];
  /** Granting organization id, when the token carries one. */
  readonly orgId?: string;
}

/** Roles arrive as an object keyed by role; anything else means "no roles". */
export function extractRoles(claim: unknown): string[] {
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return [];
  }
  return Object.keys(claim as Record<string, unknown>);
}

/**
 * Verify a Zitadel ID token and return the identity it attests.
 *
 * Throws on any failure — bad signature, wrong issuer, wrong audience, expired,
 * or missing a subject or email. Callers should treat a throw as "not signed
 * in" rather than trying to salvage partial claims.
 */
export async function verifyIdToken(
  idToken: string,
  config: ZitadelConfig,
  /**
   * The nonce generated at /auth/login. When supplied it MUST match the
   * token's `nonce` claim — this is what makes a stolen or replayed
   * authorization code useless, since the attacker cannot produce a token
   * bound to a nonce only this browser holds. Omit only where no nonce was
   * sent in the authorization request.
   */
  expectedNonce?: string,
): Promise<ZitadelIdentity> {
  const { payload } = await jwtVerify(idToken, jwks(config.issuer), {
    issuer: config.issuer,
    audience: config.clientId,
  });

  if (expectedNonce !== undefined) {
    if (payload.nonce !== expectedNonce) {
      throw new Error("zitadel: id_token nonce mismatch");
    }
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("zitadel: id_token has no subject");
  }
  const email = payload.email;
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("zitadel: id_token has no email");
  }

  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    roles: extractRoles(payload[ROLES_CLAIM]),
    orgId:
      typeof payload[ORG_ID_CLAIM] === "string"
        ? (payload[ORG_ID_CLAIM] as string)
        : undefined,
  };
}

/**
 * Is this identity an internal operator?
 *
 * Two independent conditions, both required when configured:
 *
 * 1. It holds at least one role on the platform console project. Zitadel's
 *    "Only authorized users can authenticate" setting should already deny
 *    role-less users at the IdP, but the console must not depend on a remote
 *    checkbox staying ticked — this is the same check enforced locally.
 * 2. It belongs to the internal organization, when `internalOrgId` is set.
 *
 * This exists because the session cookie is scoped to `.tesserix.app` and
 * SHARED between the marketing app and the console. Today every session is a
 * staff session, so "valid session" and "internal user" coincide. They stop
 * coinciding the moment `apps/web` admits any other kind of user, and at that
 * point a customer's cookie would otherwise be accepted by the console.
 */
// ---------------------------------------------------------------------
// MACHINE TOKENS
//
// A Zitadel service user (a machine, e.g. mark8ly reading the plan catalog)
// authenticates the same way an operator's browser does — a bearer token
// verified against this issuer's JWKS — but two of the assumptions above do
// not hold for it:
//
// 1. `ZitadelIdentity.email` is required. A service user need not have one,
//    and this module will not fabricate a placeholder: a synthetic email in
//    an audit trail is worse than an absent field. Machine identities are
//    therefore a distinct shape (`MachineIdentity`) rather than widening
//    `ZitadelIdentity` and forcing every operator call site to re-check for
//    an email that, for operators, always exists.
//
// 2. `ZitadelConfig.clientId` is documented as "OIDC client id of the
//    `apps/web` application" and is what an operator's ID token carries as
//    `aud`. A service-user access token is minted for a different
//    application/API resource and will carry a DIFFERENT audience. This
//    module does not know that value — establishing it requires looking at
//    a real token issued by the live Zitadel instance for the service user
//    that will call the catalog-read route, which this package cannot do.
//    Rather than relax or skip the audience check (the one thing that proves
//    the token was minted for THIS route and not reused from elsewhere), a
//    separate `ZitadelMachineConfig.audience` is required, sourced from its
//    own environment variable. See `getZitadelMachineConfig` below for
//    exactly which variable must be provisioned before this can verify a
//    real token.
// ---------------------------------------------------------------------

export interface MachineIdentity {
  readonly sub: string;
  /** `azp` claim — the client the token was issued to, when present. */
  readonly clientId?: string;
  /** Raw role keys from the token. Narrow with `toCapabilities`. */
  readonly roles: readonly string[];
  /** Granting organization id, when the token carries one. */
  readonly orgId?: string;
}

export interface ZitadelMachineConfig {
  /** Issuer origin, e.g. `https://auth.tesserix.app`. Same IdP as operators. */
  readonly issuer: string;
  /**
   * Expected `aud` on a machine access token.
   *
   * Deliberately NOT `ZitadelConfig.clientId` — that is `apps/web`'s OIDC
   * client id and is what an operator's ID token carries, not what a service
   * user's access token carries. Defaulting this to `clientId` would let a
   * browser-flow token that happens to reach this code path pass as a
   * machine credential.
   */
  readonly audience: string;
  /**
   * Organization id that denotes an INTERNAL service user. Optional: when
   * unset, org is not checked and role possession alone gates access.
   */
  readonly internalOrgId?: string;
}

/**
 * Build machine-token verification config from the environment.
 *
 * REQUIRES A NEW ENVIRONMENT VARIABLE NOT YET PROVISIONED ANYWHERE:
 * `ZITADEL_MACHINE_AUDIENCE`. This package cannot determine the correct
 * value on its own — it is whatever `aud` Zitadel puts on an access token
 * issued to the specific service user/API application that calls the
 * catalog-read route, and that can only be read off a real token from the
 * live instance. Do not fill this in with a guess (e.g. reusing
 * `ZITADEL_CLIENT_ID`'s value): a wrong-but-present value fails closed
 * (every token rejected), which is safe; a value that accidentally matches
 * something else would silently widen who this route accepts.
 */
export function getZitadelMachineConfig(): ZitadelMachineConfig {
  const issuer = process.env.ZITADEL_ISSUER;
  if (!issuer) throw new Error("ZITADEL_ISSUER is not set");
  const audience = process.env.ZITADEL_MACHINE_AUDIENCE;
  if (!audience) throw new Error("ZITADEL_MACHINE_AUDIENCE is not set");
  return {
    issuer: issuer.replace(/\/$/, ""),
    audience,
    internalOrgId: process.env.ZITADEL_INTERNAL_ORG_ID || undefined,
  };
}

/** Why a machine credential was rejected, distinctly from "not authorized". */
export type MachineTokenRejectionReason = "missing-token" | "invalid-token";

/**
 * Thrown by `verifyMachineAuthHeader`. Distinct from `CapabilityError`
 * (capabilities.ts): this class means "not a usable identity at all" —
 * `CapabilityError` means "a usable identity that lacks the capability it
 * needs", thrown separately once the caller checks `identity.roles` with
 * `toCapabilities`/`assertCapability`.
 */
export class MachineTokenError extends Error {
  readonly reason: MachineTokenRejectionReason;
  /**
   * The underlying `jose` verification failure, for logging. Not exposed via
   * the standard `Error.cause` (this package's target lib predates it) — read
   * it directly as `err.cause`.
   */
  readonly cause?: unknown;

  constructor(
    reason: MachineTokenRejectionReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "MachineTokenError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Turn an `Authorization` header into a verified machine identity, or throw
 * a typed `MachineTokenError`.
 *
 * `reason === "missing-token"`: the header was absent, empty, or not a
 * well-formed `Bearer <token>` value. No verification was attempted.
 *
 * `reason === "invalid-token"`: a token was present but failed verification
 * — bad signature, wrong issuer, wrong audience, expired, or missing a
 * subject. `err.cause` carries the underlying `jose` error for logging;
 * treat the message shown to a caller as opaque, since (as with
 * `verifyIdToken`) partial claims from a failed verification must never be
 * trusted or surfaced.
 *
 * Capability is NOT checked here. A valid machine identity that lacks
 * `read-plan-catalog` is a separate, later failure — call
 * `assertCapability(identity.roles, "read-plan-catalog")` (capabilities.ts)
 * once this resolves, and let its `CapabilityError` distinguish "no token" /
 * "bad token" (this function) from "valid but lacking the capability"
 * (`CapabilityError`).
 */
export async function verifyMachineAuthHeader(
  authHeader: string | null | undefined,
  config: ZitadelMachineConfig,
): Promise<MachineIdentity> {
  const token = bearerToken(authHeader);
  if (!token) {
    throw new MachineTokenError(
      "missing-token",
      "zitadel: missing or malformed Authorization header",
    );
  }

  try {
    const { payload } = await jwtVerify(token, jwks(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("zitadel: machine token has no subject");
    }

    return {
      sub: payload.sub,
      clientId: typeof payload.azp === "string" ? payload.azp : undefined,
      roles: extractRoles(payload[ROLES_CLAIM]),
      orgId:
        typeof payload[ORG_ID_CLAIM] === "string"
          ? (payload[ORG_ID_CLAIM] as string)
          : undefined,
    };
  } catch (err) {
    throw new MachineTokenError(
      "invalid-token",
      "zitadel: machine token failed verification",
      err,
    );
  }
}

export function isInternal(
  identity: Pick<ZitadelIdentity, "roles" | "orgId">,
  config: Pick<ZitadelConfig, "internalOrgId">,
): boolean {
  if (identity.roles.length === 0) return false;
  if (config.internalOrgId && identity.orgId !== config.internalOrgId) {
    return false;
  }
  return true;
}
