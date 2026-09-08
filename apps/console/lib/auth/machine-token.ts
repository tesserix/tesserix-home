// `server-only`: this module holds a client secret and mints a bearer token
// with it. Neither may ever reach a browser bundle.
import "server-only";

import { withDeadline } from "./deadline";

/**
 * The console's own MACHINE credential for the platform API (#618).
 *
 * # Why this is a second module and not a branch in `platform-token.ts`
 *
 * `resolvePlatformApiToken` answers "what credential does THIS OPERATOR'S
 * SESSION hold". This answers "what credential does THE CONSOLE ITSELF hold".
 * They are different principals, and platform-api models them as different
 * kinds — `KindOperator` and `KindService` (`platform-auth/verify.go`).
 *
 * THE TWO MUST NEVER BE WIRED TOGETHER, and that is the whole reason for the
 * separate module rather than an option on the existing resolver. If a machine
 * token were ever returned as a FALLBACK when no session was found, then every
 * operator-facing read in the console would keep succeeding after a session
 * expired — silently, as the machine. Two things would be wrong at once: the
 * audit trail on the platform API side would name the service principal for an
 * action a human took or did not take, and the set of data reachable without a
 * live operator session would widen to everything the machine may read. Both
 * are the kind of failure that shows up months later in an incident review, not
 * in a test run.
 *
 * So: two functions, and the CALLER states which principal it wants.
 * `lib/platform-api.ts` takes that choice as a required argument with no
 * default at the internal boundary, and `machine-token.separation.test.ts`
 * fails if the session path is ever taught to reach for this one.
 *
 * # The credential does not exist yet, and this must not be an error
 *
 * Provisioning it needs Zitadel admin access — see
 * `docs/RUNBOOK-MACHINE-CAPABILITY.md` and the "INFRASTRUCTURE HALF I CANNOT
 * DO" section of `.planning/quick/260908-mc1-machine-credential/PLAN.md`. Until
 * a service user exists and holds `read-entitlements`, none of these variables
 * are set on any deployment.
 *
 * Nothing here therefore throws at import time or at boot, and an unset
 * credential is a first-class ANSWER — `{ token: null, unavailable:
 * "not-configured" }` — rather than a crash, an empty string, or a silence a
 * caller could mistake for a token. The console keeps behaving exactly as it
 * does today for as long as the credential is absent.
 */

/** Zitadel's `client_credentials` client id for the console's machine user. */
const ENV_CLIENT_ID = "ZITADEL_MACHINE_CLIENT_ID";
/** Its client secret. */
const ENV_CLIENT_SECRET = "ZITADEL_MACHINE_CLIENT_SECRET";
/**
 * Optional override for the token endpoint. Normally derived from
 * `ZITADEL_ISSUER`, because the machine user lives on the same instance the
 * operators do.
 */
const ENV_TOKEN_URL = "ZITADEL_MACHINE_TOKEN_URL";
/**
 * Optional override for the project whose audience the token must carry.
 * Normally `ZITADEL_PROJECT_ID`: the runbook confirms platform-api verifies
 * against the SAME project the console signs operators into.
 *
 * It is configuration and not a constant deliberately. Three Zitadel ids look
 * interchangeable here — project, org, and OIDC app client id — and two of them
 * appear in one token; a hard-coded project id is a value nobody can correct
 * without a deploy when the estate moves.
 */
const ENV_PROJECT_ID = "ZITADEL_MACHINE_PROJECT_ID";

export interface MachineCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Absolute URL of Zitadel's token endpoint. */
  readonly tokenUrl: string;
  /** Project id whose `:aud` scope the token must request. */
  readonly projectId: string;
}

/**
 * What the environment says about the machine credential.
 *
 * `absent` and `incomplete` are kept apart on purpose. "Nothing is configured"
 * is the expected state of every deployment today and is not worth a log line.
 * "Half of it is configured" is a deploy that went wrong — a secret that did
 * not land, an ESO key with the wrong name — and it is worth naming, because
 * the symptom is otherwise identical.
 */
export type MachineCredentialResolution =
  | { readonly state: "configured"; readonly credential: MachineCredential }
  | { readonly state: "absent" }
  | { readonly state: "incomplete"; readonly missing: readonly string[] };

function trimmed(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Zitadel's token endpoint on the operator issuer, when one is configured. */
function derivedTokenUrl(): string | undefined {
  const issuer = trimmed("ZITADEL_ISSUER");
  return issuer ? `${issuer.replace(/\/+$/, "")}/oauth/v2/token` : undefined;
}

/**
 * Read the credential out of the environment. Never throws.
 *
 * Read on every call rather than memoised: `process.env` is mutable in this
 * process — Next.js reads it per request in dev, and every test in
 * `machine-token.test.ts` stubs it — and a module-scope snapshot would freeze
 * whatever the first caller happened to see.
 */
export function machineCredential(): MachineCredentialResolution {
  const clientId = trimmed(ENV_CLIENT_ID);
  const clientSecret = trimmed(ENV_CLIENT_SECRET);
  // Neither half of the credential proper: this deployment has not been given
  // one, which is the ordinary state and not a fault.
  if (!clientId && !clientSecret) return { state: "absent" };

  const tokenUrl = trimmed(ENV_TOKEN_URL) ?? derivedTokenUrl();
  const projectId = trimmed(ENV_PROJECT_ID) ?? trimmed("ZITADEL_PROJECT_ID");

  const missing: string[] = [];
  if (!clientId) missing.push(ENV_CLIENT_ID);
  if (!clientSecret) missing.push(ENV_CLIENT_SECRET);
  if (!tokenUrl) missing.push(`${ENV_TOKEN_URL} (or ZITADEL_ISSUER)`);
  if (!projectId) missing.push(`${ENV_PROJECT_ID} (or ZITADEL_PROJECT_ID)`);
  if (missing.length > 0) return { state: "incomplete", missing };

  return {
    state: "configured",
    credential: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      tokenUrl: tokenUrl as string,
      projectId: projectId as string,
    },
  };
}

/**
 * The scopes a machine token must request, and the one that is always
 * forgotten.
 *
 * `urn:zitadel:iam:org:project:id:{projectId}:aud` puts the platform API's
 * project in the token's AUDIENCE. Without it Zitadel issues a token that
 * verifies perfectly and is then refused by platform-api's audience check
 * (`ErrAudience`) — a 401 that looks like a bad secret and is not.
 *
 * `urn:zitadel:iam:org:projects:roles` is what carries the grant. Note that a
 * machine token carries it back in the PROJECT-SCOPED form
 * (`urn:zitadel:iam:org:project:{projectId}:roles`), not the flat form an
 * operator token carries, and carries no `urn:zitadel:iam:org:id` at all. That
 * is expected for a machine; see `docs/RUNBOOK-MACHINE-CAPABILITY.md`.
 *
 * This string is copied from mark8ly's working `client_credentials` client. Do
 * not "tidy" it.
 */
export function machineScopes(projectId: string): string {
  return [
    "openid",
    `urn:zitadel:iam:org:project:id:${projectId}:aud`,
    "urn:zitadel:iam:org:projects:roles",
  ].join(" ");
}

/**
 * How long to wait on Zitadel before giving up.
 *
 * Unlike the operator refresh, this holds no database transaction and no
 * pooled connection — a `client_credentials` grant spends nothing and rotates
 * nothing, so there is no lock to starve anything with. The bound exists only
 * so a hung IdP cannot pin a request (or a nightly job) indefinitely, and it is
 * comfortably longer than the 3s the refresh path must live inside.
 */
const MINT_TIMEOUT_MS = 5_000;

/**
 * Mint this far ahead of expiry.
 *
 * The same reasoning as `RENEW_WITHIN_SECONDS` in `platform-token.ts`: a token
 * with ten seconds left has to survive this request, the hop to platform-api,
 * and that service's clock. A cached token used past its expiry produces a 401
 * that reads exactly like a misconfigured grant, which is an expensive hour to
 * spend on a cache bug.
 */
const MINT_BEFORE_EXPIRY_SECONDS = 60;

export type MachineTokenUnavailable =
  /** No machine credential on this deployment. The expected state today. */
  | "not-configured"
  /** Some of the credential is set and some is not — see `machineCredential`. */
  | "incomplete-configuration"
  /** Zitadel refused, was unreachable, or answered with no usable token. */
  | "mint-failed";

/**
 * A machine token, or the reason there is none.
 *
 * Discriminated so `token: null` always arrives WITH a reason: a caller cannot
 * accidentally treat "not configured" as "the mint failed", and cannot receive
 * a null it has no explanation for.
 */
export type MachineTokenResult =
  | { readonly token: string; readonly unavailable?: undefined }
  | { readonly token: null; readonly unavailable: MachineTokenUnavailable };

interface CachedToken {
  /** Identifies the credential this token was minted with — see `cacheKey`. */
  readonly key: string;
  readonly token: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/**
 * The process-wide cache, and why one is safe here when it is not on the
 * operator path.
 *
 * A `client_credentials` grant is not a one-use credential: minting twice is
 * wasteful, never destructive, and — crucially — cannot invalidate the token
 * another caller is holding. That is the whole difference from the operator
 * refresh token, which Zitadel ROTATES and which therefore needs a row lock
 * shared across replicas (`renewUnderLock`). None of that machinery is
 * warranted, or even meaningful, for this.
 *
 * So the cache is deliberately the simple thing: module scope, per replica, no
 * database. A token lives roughly twelve hours, so re-minting per request would
 * mean thousands of pointless token calls a day against Zitadel; caching it
 * makes that a handful. Two replicas holding two different valid tokens is
 * fine — platform-api verifies each on its own merits.
 */
let cached: CachedToken | null = null;

/**
 * One in-flight mint at a time, per credential.
 *
 * Not for correctness — see above, a duplicate mint harms nothing — but because
 * a burst of parallel server-component renders on a cold replica would
 * otherwise fire one token request each.
 */
let inFlight: { key: string; promise: Promise<MachineTokenResult> } | null = null;

/**
 * The identity of the credential a cached token was minted with.
 *
 * The secret is deliberately NOT part of it: it must never be compared,
 * logged, or held in a second place. Client id plus token URL plus project is
 * enough to notice a deployment pointed somewhere else — a rotated secret for
 * the SAME client mints the same grant, and the stale token stays valid until
 * its own expiry either way.
 */
function cacheKey(credential: MachineCredential): string {
  return `${credential.tokenUrl}|${credential.clientId}|${credential.projectId}`;
}

function stillUsable(entry: CachedToken | null, key: string): string | null {
  if (!entry || entry.key !== key) return null;
  const now = Math.floor(Date.now() / 1000);
  return entry.expiresAt - MINT_BEFORE_EXPIRY_SECONDS > now ? entry.token : null;
}

/**
 * A token for the console's own machine identity, or a reason there is none.
 *
 * NOT a fallback for {@link import("./platform-token").resolvePlatformApiToken}
 * and never to be made one — see this module's header. A caller wanting to act
 * as the operator must call that; a caller with no operator to act as must call
 * this and say so.
 *
 * Nothing here throws: a nightly job that cannot mint a token should report
 * that it could not run, not crash the process it runs in.
 */
export async function resolveMachineToken(): Promise<MachineTokenResult> {
  const resolution = machineCredential();
  if (resolution.state === "absent") {
    return { token: null, unavailable: "not-configured" };
  }
  if (resolution.state === "incomplete") {
    // Loud, because this one is a deploy that went half-way and is otherwise
    // indistinguishable from the ordinary unconfigured state. Names the
    // variables, never a value.
    console.warn(
      `[auth] machine credential is incomplete; missing ${resolution.missing.join(", ")}`,
    );
    return { token: null, unavailable: "incomplete-configuration" };
  }

  const credential = resolution.credential;
  const key = cacheKey(credential);

  const usable = stillUsable(cached, key);
  if (usable) return { token: usable };

  if (inFlight && inFlight.key === key) return inFlight.promise;

  const promise = mint(credential, key).finally(() => {
    inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}

/** POST the `client_credentials` grant. Returns a reason, never throws. */
async function mint(
  credential: MachineCredential,
  key: string,
): Promise<MachineTokenResult> {
  // `client_secret_basic`, matching `exchangeCode` and `refreshAccessToken`:
  // both forms are permitted, and a secret in a form body is far more likely to
  // be captured by request logging somewhere along the path.
  const basic = Buffer.from(
    `${encodeURIComponent(credential.clientId)}:${encodeURIComponent(credential.clientSecret)}`,
  ).toString("base64");

  let response: Response;
  try {
    response = await withDeadline(
      fetch(credential.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: machineScopes(credential.projectId),
        }),
        cache: "no-store",
      }),
      MINT_TIMEOUT_MS,
      "zitadel machine token request timed out",
    );
  } catch (err) {
    console.error("[auth] machine token request failed", err);
    return { token: null, unavailable: "mint-failed" };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // The client id and the status, never the secret. `invalid_client` (bad
    // secret) and `invalid_scope` (the project id is wrong, or the machine user
    // has no grant on it) are the two that actually happen, and neither is
    // diagnosable from a bare status.
    console.warn(
      `[auth] machine token rejected status=${response.status} client_id=${credential.clientId} body=${text.slice(0, 300)}`,
    );
    return { token: null, unavailable: "mint-failed" };
  }

  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (err) {
    console.error("[auth] machine token response was not JSON", err);
    return { token: null, unavailable: "mint-failed" };
  }

  const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (!token) {
    console.warn("[auth] machine token response carried no access_token");
    return { token: null, unavailable: "mint-failed" };
  }

  const lifetime =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? Math.floor(body.expires_in)
      : null;
  if (lifetime !== null && lifetime > MINT_BEFORE_EXPIRY_SECONDS) {
    cached = {
      key,
      token,
      expiresAt: Math.floor(Date.now() / 1000) + lifetime,
    };
  } else {
    // No usable lifetime: USE the token, CACHE nothing. Caching a token whose
    // expiry we had to guess is how a cache starts handing out dead bearers,
    // and the 401 that produces reads as a misconfigured grant rather than as a
    // stale cache. Minting again next time costs one request.
    cached = null;
  }
  return { token };
}
