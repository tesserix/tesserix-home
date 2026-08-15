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
