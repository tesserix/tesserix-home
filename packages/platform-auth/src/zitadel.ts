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

/**
 * The PROJECT-SCOPED roles claim for one project.
 *
 * An ACCESS token — machine or operator — carries roles under this name, not
 * under the flat {@link ROLES_CLAIM} an operator's ID token carries. An
 * operator's access token carries BOTH, and only this form is correct: the
 * flat one is not scoped to a project, so honouring it would let roles granted
 * on a DIFFERENT project satisfy a check about this one. That distinction cost
 * a day when `verifyMachineAuthHeader` read the flat claim and silently got
 * `[]` for every real machine token — see tesserix-home#433.
 *
 * A FUNCTION, and exported, so the two callers that need this string cannot
 * spell it differently. The console's capability revalidation
 * (`apps/console/lib/auth/platform-token.ts`) reads it off a refreshed access
 * token; `verifyMachineAuthHeader` below reads it off a service user's. A
 * template literal written out twice is one typo away from an authorization
 * check that quietly finds no roles and refuses everyone, which is a failure
 * that looks like a permissions problem rather than a string bug.
 */
export function projectRolesClaim(projectId: string): string {
  return `urn:zitadel:iam:org:project:${projectId}:roles`;
}

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

/**
 * The roles a freshly-issued ACCESS token attests, or null when it attests
 * nothing this code can read.
 *
 * # Why this exists
 *
 * `/auth/callback` reads an operator's roles once, at login, and the session
 * cookie carries that snapshot for seven days. Revoking a grant in Zitadel
 * therefore took up to a week to take effect (tesserix-home#285). The console
 * closes that window by refreshing the access token every few minutes and
 * re-reading the roles off the NEW one — this function — rather than trusting
 * the cookie's snapshot.
 *
 * # It VERIFIES, and that is not belt-and-braces
 *
 * This module's header rejects decode-only for exactly this token: roles that
 * decide whether someone may rotate live payment keys must be
 * cryptographically attributable, not merely well-formed. That the token
 * arrived over TLS from the issuer moments ago makes decoding DEFENSIBLE, not
 * correct, and the whole point of this path is that its answer OVERRIDES a
 * signed session claim. A widening decision has to rest on the signature.
 *
 * The JWKS is the same cached remote set every other verification here uses,
 * so the cost after the first call is arithmetic.
 *
 * # PROJECT-SCOPED CLAIM ONLY
 *
 * An operator's access token carries BOTH the flat {@link ROLES_CLAIM} and the
 * project-scoped {@link projectRolesClaim} form. Only the latter is read, and
 * there is deliberately no fallback: the flat claim names no project, so
 * honouring it would let a grant on a DIFFERENT project decide what an
 * operator may do in this console. See tesserix-home#433, where reading the
 * wrong one of these two silently produced `[]` for every real token.
 *
 * # `[]` IS AN ANSWER; `null` IS NOT
 *
 * A verified token with no roles claim returns `[]` — "this operator holds
 * nothing on this project" — because that is what Zitadel emits when every
 * grant has been removed, and reading it as anything else would defeat the
 * revocation this function exists to deliver. Every other outcome — an opaque
 * token, a bad signature, a wrong issuer, an expired token, a claim of an
 * unexpected shape — returns null, meaning "no answer", and the caller must
 * keep whatever it had rather than treat silence as revocation.
 *
 * # DEPLOY PRECONDITION: THE APPLICATION MUST ISSUE **JWT** ACCESS TOKENS
 *
 * Zitadel applications default to OPAQUE bearer access tokens; the roles claim
 * is readable only when the application's auth token type is JWT. With the
 * default, every call here returns null, the caller falls back to the cookie,
 * and revocation quietly reverts to its seven-day window with nothing failing.
 * That is why the caller logs a warning rather than staying silent — see
 * `apps/console/lib/auth/platform-token.ts`.
 */
export async function rolesFromAccessToken(
  accessToken: string,
  config: { readonly issuer: string; readonly projectId: string },
): Promise<string[] | null> {
  if (!accessToken || !config.issuer || !config.projectId) return null;
  try {
    const { payload } = await jwtVerify(accessToken, jwks(config.issuer), {
      issuer: config.issuer,
      // The project, not the OIDC client id. The console asks for
      // `urn:zitadel:iam:org:project:id:{projectId}:aud` at authorization,
      // which is the same scope that puts the roles claim on the token — so a
      // token carrying the claim carries this audience by construction, and
      // one that does not is not a token whose roles this project should read.
      audience: config.projectId,
    });
    const claim = payload[projectRolesClaim(config.projectId)];
    // Absent means "no grants on this project" — Zitadel omits the claim
    // rather than emitting an empty object — and that is a real, actionable
    // answer. `extractRoles` returns [] for a present-but-unreadable shape
    // too, which is the same conclusion by a less likely route.
    if (claim === undefined) return [];
    return extractRoles(claim);
  } catch {
    // Opaque token, wrong issuer, expired, bad signature. Nothing here is worth
    // logging from a shared package — the caller knows which session it was
    // asking about and logs that. Never throws: a revalidation that cannot
    // happen must not take down the action it was checking.
    return null;
  }
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
 * Pull the granting org id out of a roles claim value.
 *
 * Each role key maps to an object of `{ <orgId>: <orgDomain> }` — see the
 * `ROLES_CLAIM` docstring. This returns the first org id found among the
 * role entries. In practice every role on a given token is granted by the
 * same org (a service user belongs to one org), so "first" and "only" agree;
 * this does not attempt to reconcile a token whose roles somehow named
 * different granting orgs.
 */
function extractOrgIdFromRolesClaim(claim: unknown): string | undefined {
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return undefined;
  }
  for (const roleValue of Object.values(claim as Record<string, unknown>)) {
    if (typeof roleValue === "object" && roleValue !== null && !Array.isArray(roleValue)) {
      const orgIds = Object.keys(roleValue as Record<string, unknown>);
      if (orgIds.length > 0) return orgIds[0];
    }
  }
  return undefined;
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
 *
 * `verifyMachineAuthHeader` below reuses this HELPER FUNCTION verbatim to
 * gate on `internalOrgId` for machine identities too — `MachineIdentity`
 * carries the same `roles` / `orgId` shape this function needs, so there is
 * no separate machine-specific check function. That is reuse of this
 * function's logic, NOT a claim that it matches the real operator login
 * gate: `apps/console/app/auth/callback/route.ts` actually gates entry with
 * an inline org match plus an email allowlist and never calls this function
 * or checks `roles.length`. This function and that route have independently
 * decided what "internal" means; they are not guaranteed to agree.
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
  /**
   * The client the token was issued to, for log attribution — not read for
   * any auth decision.
   *
   * A real `mark8ly-catalog-reader` access token carries this as `client_id`
   * and has NO `azp` claim at all (confirmed against a real decoded token —
   * the same one that exposed the roles-claim bug this module fixes
   * elsewhere). `azp` is an OIDC ID-token concept; a client_credentials
   * access token is the OAuth2 shape, which names the client as `client_id`
   * instead. `client_id` is read first for that reason; `azp` is kept as a
   * fallback in case some other machine-token shape carries it instead, but
   * it is not the claim a real token here actually has.
   */
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
   * The Zitadel project whose roles this machine path reads.
   *
   * A machine access token does NOT carry the flat `urn:zitadel:iam:org:
   * project:roles` claim an operator's ID token carries — it carries a
   * PROJECT-SCOPED form instead: `urn:zitadel:iam:org:project:{projectId}:
   * roles`. `verifyMachineAuthHeader` needs `{projectId}` to know which
   * claim to read, and it comes from here — deliberately NOT inferred from
   * the token's own `aud`, even though the two happen to be equal in this
   * deployment today. `aud` answers "who is this token for"; `projectId`
   * answers "whose roles am I reading". Sourcing the second from the first
   * would make that distinction hold only by coincidence, and a future
   * Zitadel project/application layout where they diverge would silently
   * start reading the wrong (or no) roles claim rather than failing loudly.
   */
  readonly projectId: string;
  /**
   * Organization id that denotes an INTERNAL service user. Optional: when
   * unset, org is not checked and role possession alone gates access.
   *
   * NOTE ON HOW THIS IS POPULATED FOR MACHINE IDENTITIES: a real machine
   * token does not carry `ORG_ID_CLAIM` (`urn:zitadel:iam:org:id`) at all —
   * `verifyMachineAuthHeader` derives `MachineIdentity.orgId` from the
   * project-scoped roles claim's nested value instead (see
   * `extractOrgIdFromRolesClaim`). This field's meaning is unchanged; only
   * where the machine path gets the org id to compare against it differs
   * from the operator path.
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
  // `ZITADEL_PROJECT_ID` is already provisioned on the console deployment
  // (`platform-api/README.md` documents it for the Go side) — no new
  // environment variable needed. Fail closed the same way `audience` does
  // above: a machine verifier that cannot name its project cannot read
  // roles, and silently falling back to "no project" would return `[]`
  // roles for every real token, which is exactly the bug this fixes.
  const projectId = process.env.ZITADEL_PROJECT_ID;
  if (!projectId) throw new Error("ZITADEL_PROJECT_ID is not set");
  return {
    issuer: issuer.replace(/\/$/, ""),
    audience,
    projectId,
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

  // `jose` skips the `aud` comparison entirely when `audience` is falsy
  // (empty string included), so a config built with `audience: ""` would
  // accept a token minted for ANY audience. Fail closed here rather than
  // relying solely on `getZitadelMachineConfig` rejecting an unset env var —
  // this function is exported and a future caller can construct a config
  // directly, bypassing that reader.
  if (!config.audience) {
    throw new MachineTokenError(
      "invalid-token",
      "zitadel: machine config has no audience configured",
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

    // A machine access token carries roles under the PROJECT-SCOPED claim
    // `urn:zitadel:iam:org:project:{projectId}:roles`, not the flat
    // `ROLES_CLAIM` an operator's ID token carries — confirmed against a
    // real token minted for the `mark8ly-catalog-reader` service user. Using
    // `ROLES_CLAIM` here silently returned `[]` for every real machine
    // token, which then failed `assertCapability` and surfaced as a 403
    // that looked like a permissions problem rather than a claim-shape bug.
    //
    // Deliberately project-scoped ONLY, no fallback to the flat claim: this
    // package has already seen `claims_supported` omit claims Zitadel still
    // emits (see `ROLES_CLAIM`'s docstring), so a flat claim showing up on
    // some future token cannot be ruled out. But accepting it here would let
    // a token carrying roles for a DIFFERENT project satisfy this check, if
    // Zitadel or a different application ever emitted that shape — the
    // audience check narrows "which application", not "which project", so
    // this would be a real widening of who can pass. If the flat claim ever
    // legitimately needs to be honored for machine tokens too, that should
    // be a deliberate, reviewed addition, not a quiet "accept either".
    const rolesClaimValue = payload[projectRolesClaim(config.projectId)];

    const identity: MachineIdentity = {
      sub: payload.sub,
      clientId:
        typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string"
            ? payload.azp
            : undefined,
      roles: extractRoles(rolesClaimValue),
      // `ORG_ID_CLAIM` (`urn:zitadel:iam:org:id`) is ALSO absent from a real
      // machine token — the granting org appears only nested inside the
      // roles claim's value instead. Derive it from there rather than
      // leaving `orgId` permanently `undefined` for every machine caller:
      // that would be harmless only for as long as `ZITADEL_INTERNAL_ORG_ID`
      // stays unset, and would turn into an inexplicable 403 for every
      // machine caller the moment someone sets it.
      orgId: extractOrgIdFromRolesClaim(rolesClaimValue),
    };

    // Enforced, not merely documented: a service user holding the project
    // role but belonging to the wrong organization must not pass. Reuses
    // `isInternal` rather than a second ad hoc check — `MachineIdentity`
    // structurally satisfies the `Pick<ZitadelIdentity, "roles" | "orgId">`
    // it expects.
    if (!isInternal(identity, config)) {
      throw new Error("zitadel: machine token is not from the internal organization");
    }

    return identity;
  } catch (err) {
    if (err instanceof MachineTokenError) throw err;
    throw new MachineTokenError(
      "invalid-token",
      "zitadel: machine token failed verification",
      err,
    );
  }
}
