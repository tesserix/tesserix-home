import {
  classifyAuthMethods,
  decideSufficiency,
  idpChecked,
  noChecks,
  unknownFactors,
  unknownPolicy,
  type EnrolledFactors,
  type LoginPolicySnapshot,
  type Sufficiency,
} from "./login-sufficiency";

/**
 * Zitadel's session API, as driven by a "login client".
 *
 * This is what lets the console host its own login page instead of redirecting
 * to Zitadel's. The application creates a session, checks credentials against
 * it, and hands the session to the pending OIDC auth request, which answers
 * with the callback URL to send the browser to.
 *
 * # It authenticates as a machine user, not as the operator
 *
 * Every call here carries `ZITADEL_LOGIN_CLIENT_TOKEN` — a PAT belonging to a
 * machine user holding the `IAM_LOGIN_CLIENT` role. That token can check
 * anyone's password and mint a session for anyone, so it is the most powerful
 * credential this application holds. It never leaves the server, never reaches
 * a route handler's response, and the module refuses to work rather than fall
 * back to something weaker when it is absent.
 *
 * # Zitadel does not enforce MFA on this path
 *
 * Stated again here because it is the thing a reader of this file most needs
 * to know: a password-only session will be issued an authorization code even
 * under a `forceMfa` policy. `finalize` therefore refuses to run without a
 * `Sufficient` token, which only `checkSufficiency` can produce. Forgetting
 * the check is a type error, not a review comment.
 */

export class LoginClientError extends Error {
  readonly kind: "unconfigured" | "bad-credentials" | "unknown-user" | "auth-request" | "upstream";
  /**
   * The HTTP status, when there was one.
   *
   * Kept because Zitadel does not use one status for "you got the secret
   * wrong": a bad password is 401, a bad TOTP code is 400 InvalidArgument.
   * Without the status, the second reads as "upstream" — i.e. "sign-in is
   * temporarily unavailable" — which tells an operator to wait out an outage
   * that is really a mistyped digit. Server-side only; never rendered.
   */
  readonly status?: number;

  constructor(
    kind: LoginClientError["kind"],
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "LoginClientError";
    this.kind = kind;
    this.status = options?.status;
  }
}

interface LoginClientConfig {
  readonly issuer: string;
  readonly token: string;
}

/**
 * Read the configuration, or refuse.
 *
 * Absent config is `unconfigured` rather than a thrown string, because the
 * login page renders a different thing for it: "this deployment cannot host
 * its own login" is an operator problem, not a credential problem, and telling
 * a user their password was wrong would be a lie.
 */
export function loginClientConfig(): LoginClientConfig | null {
  const issuer = process.env.ZITADEL_ISSUER?.trim();
  const token = process.env.ZITADEL_LOGIN_CLIENT_TOKEN?.trim();
  if (!issuer || !token) return null;
  return { issuer: issuer.replace(/\/+$/, ""), token };
}

async function call<T>(
  config: LoginClientConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.issuer}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (cause) {
    throw new LoginClientError("upstream", "zitadel is unreachable", { cause });
  }

  const text = await response.text();
  if (!response.ok) {
    // The body can name the exact check that failed, which belongs in the log
    // and never in a browser response — it distinguishes "no such user" from
    // "wrong password", which is precisely what the login must not reveal.
    throw new LoginClientError(
      response.status === 401 || response.status === 403 ? "bad-credentials" : "upstream",
      `zitadel ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`,
      { status: response.status },
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface AuthRequestInfo {
  readonly id: string;
  readonly clientId: string;
}

/** Read the pending OIDC auth request the browser arrived with. */
export async function getAuthRequest(
  config: LoginClientConfig,
  id: string,
): Promise<AuthRequestInfo> {
  const wire = await call<{ authRequest?: { id?: string; clientId?: string } }>(
    config,
    "GET",
    `/v2/oidc/auth_requests/${encodeURIComponent(id)}`,
  );
  const req = wire.authRequest;
  if (!req?.id) {
    throw new LoginClientError("auth-request", "auth request does not exist");
  }
  return { id: req.id, clientId: req.clientId ?? "" };
}

export interface LoginSession {
  readonly id: string;
  readonly token: string;
}

/**
 * Create a session by checking a login name and password together.
 *
 * One call, not two: Zitadel accepts both checks in a single request, and
 * splitting them would leak which half failed through response timing alone.
 */
export async function createPasswordSession(
  config: LoginClientConfig,
  loginName: string,
  password: string,
): Promise<LoginSession> {
  const wire = await call<{ sessionId?: string; sessionToken?: string }>(
    config,
    "POST",
    "/v2/sessions",
    { checks: { user: { loginName }, password: { password } } },
  );
  if (!wire.sessionId || !wire.sessionToken) {
    throw new LoginClientError("upstream", "zitadel returned no session");
  }
  return { id: wire.sessionId, token: wire.sessionToken };
}

/** The org login policy, reduced to the two flags the decision reads. */
export async function getLoginPolicy(config: LoginClientConfig): Promise<LoginPolicySnapshot> {
  try {
    const wire = await call<{ policy?: { forceMfa?: boolean; forceMfaLocalOnly?: boolean } }>(
      config,
      "GET",
      "/management/v1/policies/login",
    );
    return {
      forceMfa: wire.policy?.forceMfa === true,
      forceMfaLocalOnly: wire.policy?.forceMfaLocalOnly === true,
    };
  } catch (error) {
    // Fail closed: an unreadable policy must not read as "MFA not required".
    //
    // Said out loud, because the silent version is what let a
    // hand-off-for-everyone run for two weeks before a screenshot found it.
    // This is one of two inputs to a security decision, and an unreadable one
    // makes that decision permanent — an operator can retry forever and never
    // get past it. The message carries no secret: `LoginClientError` is built
    // from the method, path and a truncated body, never the bearer.
    console.warn("[login] could not read the login policy; assuming MFA is forced", {
      message: error instanceof Error ? error.message : String(error),
    });
    return unknownPolicy();
  }
}

/** What the session's user has enrolled. */
export async function getEnrolledFactors(
  config: LoginClientConfig,
  session: LoginSession,
): Promise<EnrolledFactors> {
  try {
    // The login-client bearer alone is enough to read the session AND its
    // factors. VERIFIED against the live instance (Zitadel v4.15.3): a plain
    // `GET /v2/sessions/{id}` with no `sessionToken` answers 200 with
    // `factors.user.id` populated. Passing `session.token` as well would be
    // harmless and is deliberately not done — it would imply the token is what
    // unlocks the factors, which is the wrong mental model to leave behind for
    // the next reader of this call.
    const wire = await call<{
      session?: { factors?: { user?: { id?: string } } };
    }>(config, "GET", `/v2/sessions/${encodeURIComponent(session.id)}`);
    const userId = wire.session?.factors?.user?.id;
    if (!userId) {
      // A session with no user factor cannot have its methods looked up, so
      // the decision has to fail closed. Logged because the result is a
      // hand-off the operator cannot escape by retrying.
      console.warn("[login] session resolved to no user; handing off", {
        sessionId: session.id,
      });
      return unknownFactors();
    }

    const methods = await call<{ authMethodTypes?: string[] }>(
      config,
      "GET",
      `/v2/users/${encodeURIComponent(userId)}/authentication_methods`,
    );
    // Absent, not empty, is how Zitadel says "none": proto3 omits an empty
    // repeated field. `?? []` is therefore the enrolled-nothing case, not a
    // parse failure — the failure case is the catch below.
    return classifyAuthMethods(methods.authMethodTypes ?? []);
  } catch (error) {
    // The other half of the security decision, and the same reasoning as the
    // policy lookup: fail closed, but say so.
    console.warn("[login] could not read the enrolled factors; handing off", {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return unknownFactors();
  }
}

/* ------------------------------------------------------------------ *
 * Federated sign-in ("Continue with Google")
 * ------------------------------------------------------------------ */

/** An identity provider bound to the org's login policy. */
export interface LoginIdp {
  readonly id: string;
  /** Zitadel's display name. Also what the button is labelled from. */
  readonly name: string;
}

/**
 * The identity providers the org's login policy actually offers.
 *
 * Read at request time and never transcribed into this repository. The Zitadel
 * bootstrap owns the Google IdP object and is free to recreate it, at which
 * point a hardcoded id becomes a button that starts an intent for a provider
 * that no longer exists — the same class of stale evidence as
 * tesserix-home#405. Reading the policy also means a SECOND provider the
 * bootstrap binds appears on this page with no code change.
 *
 * VERIFIED against the live instance (Zitadel v4.15.3): the login-client token
 * can POST this search and gets back `{"result":[{"idpId":…,"idpName":…}]}`.
 * `idpType` and `ownerType` come back omitted (proto3 drops their zero values),
 * so there is nothing here to filter on — which is why every bound provider is
 * offered rather than one picked out by type.
 *
 * Answers `[]` rather than throwing. This list is an affordance, not a
 * decision: with no providers the page renders the password form alone, which
 * still works. A button that cannot start an intent would be worse than none.
 */
export async function listLoginPolicyIdps(config: LoginClientConfig): Promise<readonly LoginIdp[]> {
  try {
    const wire = await call<{ result?: { idpId?: string; idpName?: string }[] }>(
      config,
      "POST",
      "/management/v1/policies/login/idps/_search",
      {},
    );
    return (wire.result ?? [])
      .filter((idp): idp is { idpId: string; idpName?: string } => Boolean(idp.idpId))
      .map((idp) => ({ id: idp.idpId, name: idp.idpName ?? "" }));
  } catch (error) {
    console.warn("[login] could not list the policy's identity providers", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Begin an identity-provider intent and get the URL to send the browser to.
 *
 * `successUrl` is where Zitadel returns the browser once the provider is done,
 * with `id` and `token` appended; `failureUrl` is where it goes if the
 * provider refuses. Both are absolute URLs on the console's own origin.
 */
export async function startIdpIntent(
  config: LoginClientConfig,
  idpId: string,
  urls: { successUrl: string; failureUrl: string },
): Promise<string> {
  const wire = await call<{ authUrl?: string }>(config, "POST", "/v2/idp_intents", {
    idpId,
    urls,
  });
  if (!wire.authUrl) {
    // `StartIdentityProviderIntentResponse` is a oneof: `authUrl` for the
    // redirect providers, but `formData` or `idpIntent` for others (SAML POST
    // bindings, LDAP). Google is redirect-based, and an unhandled next step
    // has to stop here rather than navigate the browser to `undefined`.
    throw new LoginClientError("upstream", "zitadel returned no idp auth url");
  }
  return wire.authUrl;
}

/**
 * Proof that Zitadel returned a completed identity-provider intent.
 *
 * Branded like `TotpVerified`, and for a sharper reason: this token is what
 * exempts a session from `forceMfaLocalOnly`. It is the only input to the
 * sufficiency decision that makes a login easier, so the only way to hold one
 * must be to have completed the intent that earns it.
 */
declare const idpBrand: unique symbol;
export interface IdpVerified {
  readonly [idpBrand]: true;
}

export interface IdpIntent {
  readonly id: string;
  readonly token: string;
}

/**
 * Read back a finished intent, and insist it belongs to an existing operator.
 *
 * Zitadel offers `createUser` here for an external identity it has never seen.
 * The console does not take that offer: a console account is a grant of
 * platform access, and signing in with a Google account is not an application
 * for one. An unlinked identity is `unknown-user`, which the page answers with
 * the same "that didn't work" it gives a bad password — whether an email is an
 * operator is not something this page may reveal.
 */
export async function retrieveIdpIntent(
  config: LoginClientConfig,
  intent: IdpIntent,
): Promise<{ userId: string; verified: IdpVerified }> {
  const wire = await call<{ userId?: string }>(
    config,
    "POST",
    `/v2/idp_intents/${encodeURIComponent(intent.id)}`,
    { idpIntentToken: intent.token },
  );
  if (!wire.userId) {
    throw new LoginClientError("unknown-user", "idp identity is linked to no zitadel user");
  }
  return { userId: wire.userId, verified: {} as IdpVerified };
}

/**
 * Create a session from a completed intent.
 *
 * The same session shape the password path produces — the auth request cannot
 * tell the two apart, and `finalize` still demands the `Sufficient` proof for
 * either. What differs is only what the sufficiency decision is told, which is
 * `IdpVerified` and nothing else.
 */
export async function createIdpSession(
  config: LoginClientConfig,
  intent: IdpIntent,
  userId: string,
): Promise<LoginSession> {
  // BOTH checks, and `user` is not optional. An `idpIntent` check alone tells
  // Zitadel the identity was proved but not WHOSE session to open, and it
  // answers `400 User ID missing (COMMAND-Sfw3r)` — observed in production
  // 2026-08-30, where the Google round trip completed and only this last call
  // failed. `retrieveIdpIntent` already resolves the linked user (and refuses
  // with `unknown-user` when the identity is linked to nobody), so the id is
  // in hand by the time we get here; it was simply not being passed.
  const wire = await call<{ sessionId?: string; sessionToken?: string }>(
    config,
    "POST",
    "/v2/sessions",
    {
      checks: {
        user: { userId },
        idpIntent: { idpIntentId: intent.id, idpIntentToken: intent.token },
      },
    },
  );
  if (!wire.sessionId || !wire.sessionToken) {
    throw new LoginClientError("upstream", "zitadel returned no session");
  }
  return { id: wire.sessionId, token: wire.sessionToken };
}

/**
 * Proof that Zitadel accepted a TOTP code against a specific session.
 *
 * Branded for the same reason as `Sufficient`: the only way to hold one is to
 * have made the call that produces it. `checkSufficiency` takes one, so
 * "assume the code was fine" is not something a caller can express.
 */
declare const totpBrand: unique symbol;
export interface TotpVerified {
  readonly [totpBrand]: true;
}

/**
 * Add an authenticator code to a session that already passed its password.
 *
 * A PATCH on the EXISTING session, not a new one: the auth request is about to
 * be handed this session id, and a second session would be a second password
 * check the operator never made. `sessionToken` is what authorises the change
 * — the login-client PAT alone cannot amend someone else's session.
 */
export async function addTotpCheck(
  config: LoginClientConfig,
  session: LoginSession,
  code: string,
): Promise<TotpVerified> {
  try {
    await call(config, "PATCH", `/v2/sessions/${encodeURIComponent(session.id)}`, {
      sessionToken: session.token,
      checks: { totp: { code } },
    });
  } catch (error) {
    // 400 is the one that matters: Zitadel answers an invalid TOTP with
    // InvalidArgument, which the generic mapping calls "upstream". Re-kinded
    // here so the page can offer a retry instead of an outage notice.
    if (error instanceof LoginClientError && error.status === 400) {
      throw new LoginClientError("bad-credentials", error.message, { status: 400 });
    }
    throw error;
  }
  return {} as TotpVerified;
}

/**
 * Proof that the sufficiency decision was made and came back "complete".
 *
 * Its only constructor is `checkSufficiency`. `finalize` requires one, so a
 * code path that finishes a login without deciding whether a second factor was
 * owed does not compile — the same guarantee helivanta gets from an unexported
 * Go type, expressed with a private symbol.
 */
declare const sufficientBrand: unique symbol;
export interface Sufficient {
  readonly [sufficientBrand]: true;
}

/**
 * Run the decision. Returns the token only when the login may complete.
 *
 * `verifiedTotp` is the branded result of `addTotpCheck`, or `null` when no
 * second factor has been offered yet. `verifiedIdp` is the branded result of
 * `retrieveIdpIntent`, or `null` for the password path. It is a parameter rather than something
 * this function could infer, because after the in-page code prompt the
 * completion has to come back through this decision — re-deriving it is what
 * keeps `Sufficient` honest. Nothing casts its way past here.
 */
export function checkSufficiency(
  policy: LoginPolicySnapshot,
  factors: EnrolledFactors,
  verifiedTotp: TotpVerified | null,
  verifiedIdp: IdpVerified | null = null,
): { sufficiency: Sufficiency; proof: Sufficient | null } {
  const sufficiency = decideSufficiency(policy, factors, {
    // Both are branded, so neither can be claimed by a caller that did not
    // make the call. That matters most for the IdP one: it is what buys the
    // `forceMfaLocalOnly` exemption, i.e. the only input to this decision that
    // makes a login EASIER.
    ...(verifiedIdp ? idpChecked() : noChecks()),
    totpVerified: verifiedTotp !== null,
  });
  return {
    sufficiency,
    proof: sufficiency.outcome === "complete" ? ({} as Sufficient) : null,
  };
}

/**
 * Hand the session to the auth request and get the callback URL.
 *
 * Takes `Sufficient` so it cannot be reached without the MFA decision. The
 * parameter is unused at runtime and that is the point: it exists to make the
 * omission a compile error.
 */
export async function finalize(
  config: LoginClientConfig,
  authRequestId: string,
  session: LoginSession,
  _proof: Sufficient,
): Promise<string> {
  const wire = await call<{ callbackUrl?: string }>(
    config,
    "POST",
    `/v2/oidc/auth_requests/${encodeURIComponent(authRequestId)}`,
    { session: { sessionId: session.id, sessionToken: session.token } },
  );
  if (!wire.callbackUrl) {
    throw new LoginClientError("upstream", "zitadel returned no callback url");
  }
  return wire.callbackUrl;
}
