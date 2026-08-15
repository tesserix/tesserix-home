/**
 * The console's own OIDC flow against Zitadel.
 *
 * The console previously had no auth of its own: it redirected anonymous
 * visitors to `apps/web`'s `/login` and consumed the `.tesserix.app` cookie web
 * minted. That made web's login policy the console's access policy, and left an
 * independent control plane unable to sign anyone in whenever web was down —
 * on an app whose admin surfaces are being retired.
 *
 * So the console authenticates directly. `apps/web` is not involved.
 */

export interface ConsoleOidcConfig {
  /** Issuer origin, no trailing slash. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /**
   * Organization whose users the console accepts, checked on the token's
   * `urn:zitadel:iam:org:id` claim. Optional: unset means "any org, provided
   * the roles are there".
   *
   * This is the user's HOME organization, not the org that owns the project.
   * Those differ here — operators live in one org and `platform-console` is in
   * another — and conflating them is what broke the first cutover attempt.
   */
  readonly internalOrgId?: string;
  /** Platform Console project — its audience scope carries the role claim. */
  readonly projectId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function getOidcConfig(): ConsoleOidcConfig {
  return {
    issuer: required("ZITADEL_ISSUER").replace(/\/$/, ""),
    clientId: required("ZITADEL_CLIENT_ID"),
    clientSecret: required("ZITADEL_CLIENT_SECRET"),
    redirectUri: required("ZITADEL_REDIRECT_URI"),
    internalOrgId: process.env.ZITADEL_INTERNAL_ORG_ID || undefined,
    projectId: required("ZITADEL_PROJECT_ID"),
  };
}

/**
 * Scopes requested at authorization.
 *
 * `urn:zitadel:iam:org:project:id:{projectId}:aud` puts the Platform Console
 * project in the token's audience, which is what guarantees its roles appear in
 * the role claim. The project and application settings are supposed to ensure
 * this too, but they are checkboxes in a UI and this is one string in code —
 * and the failure mode when they are wrong is a perfectly valid token carrying
 * no roles, which reads as an application bug.
 *
 * NO ORG SCOPE. An earlier version pinned login to the organization that owns
 * the project (`urn:zitadel:iam:org:id:...`), on the assumption that operators
 * would live there. They do not: the project sits in one org and every human
 * account in another. Scoping login to the project's org made Zitadel try to
 * authenticate people as members of an org they do not belong to, find nothing,
 * fall through to auto-creation, and fail with `409 User already exists`
 * against the globally-unique username they already hold elsewhere. Auto-linking
 * cannot rescue that, because it searches within the org being signed into.
 *
 * Without the scope, people authenticate in their home organization and the
 * project's roles resolve regardless — role grants are project-scoped, not
 * org-scoped. Which org a token came from is then checked separately, against
 * `internalOrgId`, on the way back.
 */
export function scopesFor(config: ConsoleOidcConfig): string {
  return [
    "openid",
    "profile",
    "email",
    "offline_access",
    `urn:zitadel:iam:org:project:id:${config.projectId}:aud`,
  ].join(" ");
}

export function buildAuthorizationUrl(
  config: ConsoleOidcConfig,
  params: { state: string; nonce: string },
): string {
  const url = new URL(`${config.issuer}/oauth/v2/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopesFor(config));
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  return url.toString();
}

export interface TokenResponse {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

/**
 * Exchange an authorization code for tokens using `client_secret_basic`.
 *
 * The secret goes in the Authorization header rather than the form body: both
 * are permitted by the discovery document, but a body parameter is far more
 * likely to be captured by request logging somewhere along the path.
 */
export async function exchangeCode(
  config: ConsoleOidcConfig,
  code: string,
): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
  ).toString("base64");

  const res = await fetch(`${config.issuer}/oauth/v2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Include the redirect_uri and client id — never the secret. The two
    // failures that actually happen here are redirect_uri_mismatch and
    // invalid_client, and neither is diagnosable from a bare status code.
    throw new Error(
      `zitadel token exchange failed status=${res.status} client_id=${config.clientId} redirect_uri=${config.redirectUri} body=${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Pack a CSRF nonce and a return path into the `state` parameter.
 *
 * The nonce half is compared against an httpOnly cookie on the way back; the
 * path half is where the operator was heading before being bounced to login.
 */
export function encodeState(nonce: string, returnTo: string): string {
  return `${nonce}.${Buffer.from(returnTo).toString("base64url")}`;
}

export function decodeState(
  state: string | null | undefined,
): { nonce: string; returnTo: string } | null {
  if (!state) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const nonce = state.slice(0, dot);
  try {
    const returnTo = Buffer.from(state.slice(dot + 1), "base64url").toString(
      "utf8",
    );
    return { nonce, returnTo: safeReturnPath(returnTo) };
  } catch {
    return null;
  }
}

/**
 * Only same-origin relative paths may be returned to.
 *
 * Rejects absolute URLs, protocol-relative `//evil.com` and backslash variants.
 * `state` survives a round trip through a third party, so it must be treated as
 * attacker-influenced even though we generated it.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
