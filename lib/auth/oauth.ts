// lib/auth/oauth.ts — Google OAuth helpers + email allowlist.

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
}

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTHZ_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function getOAuthClientId(): string {
  const id = process.env.OAUTH_CLIENT_ID;
  if (!id) throw new Error("OAUTH_CLIENT_ID is not set");
  return id;
}

export function getOAuthClientSecret(): string {
  const s = process.env.OAUTH_CLIENT_SECRET;
  if (!s) throw new Error("OAUTH_CLIENT_SECRET is not set");
  return s;
}

export function getOAuthRedirectUri(): string {
  const u = process.env.OAUTH_REDIRECT_URI;
  if (!u) throw new Error("OAUTH_REDIRECT_URI is not set");
  return u;
}

export function buildAuthorizationUrl(params: {
  state: string;
  scope?: string;
  prompt?: string;
}): string {
  const url = new URL(GOOGLE_AUTHZ_ENDPOINT);
  url.searchParams.set("client_id", getOAuthClientId());
  url.searchParams.set("redirect_uri", getOAuthRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    params.scope ?? "openid email profile",
  );
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "true");
  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
  }
  return url.toString();
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: getOAuthClientId(),
    client_secret: getOAuthClientSecret(),
    redirect_uri: getOAuthRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Surface Google's full error in the server log so the operator can
    // distinguish redirect_uri_mismatch / invalid_client / invalid_grant
    // from a generic network failure.
    // eslint-disable-next-line no-console
    console.error(
      "[oauth] token exchange failed",
      JSON.stringify({
        status: res.status,
        body: text.slice(0, 500),
        client_id: getOAuthClientId().slice(0, 24) + "…",
        redirect_uri: getOAuthRedirectUri(),
      }),
    );
    throw new Error(`token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

// Decode an id_token payload WITHOUT signature verification. This is
// safe HERE because we just exchanged the code with Google over TLS for
// this id_token — we trust the channel, not the token cryptography.
// For tokens received from untrusted sources, swap in jose's jwtVerify
// against Google's JWKS.
export function decodeIdTokenUnsafe(idToken: string): GoogleIdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("id_token: malformed");
  }
  const payload = parts[1];
  const decoded = Buffer.from(
    payload.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  return JSON.parse(decoded) as GoogleIdTokenClaims;
}

// Email allowlist — only addresses listed in ALLOWED_ADMIN_EMAILS may
// sign in. Comma-separated, lowercase compared. Empty allowlist means
// "block everyone" (fail-closed) so a misconfigured chart doesn't
// silently let the world in.
export function isEmailAllowed(email: string): boolean {
  const raw = process.env.ALLOWED_ADMIN_EMAILS;
  if (!raw) return false;
  const allow = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return allow.has(email.toLowerCase());
}

// Validate a "returnTo" path before redirecting the browser to it.
// Only relative paths inside the same app are allowed; anything that
// looks like a host or protocol is dropped to prevent open-redirect.
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return "/admin/dashboard";
  if (!raw.startsWith("/")) return "/admin/dashboard";
  // Reject "//evil.com" (protocol-relative) and "/\\evil.com".
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/admin/dashboard";
  return raw;
}
