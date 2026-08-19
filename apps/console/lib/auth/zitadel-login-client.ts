import {
  decideSufficiency,
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

  constructor(kind: LoginClientError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoginClientError";
    this.kind = kind;
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
  } catch {
    // Fail closed: an unreadable policy must not read as "MFA not required".
    return unknownPolicy();
  }
}

/** What the session's user has enrolled. */
export async function getEnrolledFactors(
  config: LoginClientConfig,
  session: LoginSession,
): Promise<EnrolledFactors> {
  try {
    const wire = await call<{
      session?: { factors?: { user?: { id?: string } } };
    }>(config, "GET", `/v2/sessions/${encodeURIComponent(session.id)}`);
    const userId = wire.session?.factors?.user?.id;
    if (!userId) return unknownFactors();

    const methods = await call<{ authMethodTypes?: string[] }>(
      config,
      "GET",
      `/v2/users/${encodeURIComponent(userId)}/authentication_methods`,
    );
    const types = methods.authMethodTypes ?? [];
    return {
      secondFactorTypes: types.filter((t) => t !== "AUTHENTICATION_METHOD_TYPE_PASSWORD" && t !== "AUTHENTICATION_METHOD_TYPE_PASSKEY"),
      passkeyCount: types.filter((t) => t === "AUTHENTICATION_METHOD_TYPE_PASSKEY").length,
    };
  } catch {
    return unknownFactors();
  }
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

/** Run the decision. Returns the token only when the login may complete. */
export function checkSufficiency(
  policy: LoginPolicySnapshot,
  factors: EnrolledFactors,
): { sufficiency: Sufficiency; proof: Sufficient | null } {
  const sufficiency = decideSufficiency(policy, factors);
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
