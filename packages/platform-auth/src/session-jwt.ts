// lib/auth/session-jwt.ts — sign + verify the super-admin session cookie.
//
// We use JWE (JWT encryption) with A256GCM and a key derived from
// SESSION_ENCRYPT_KEY. Encrypted (not just signed) so the cookie body
// can't be inspected client-side; that matches the auth-bff convention
// even though we no longer share its cookie format.
//
// Cookie shape (decrypted JWT claims):
//   sub:   Google `sub` (stable user id)
//   email: Google email (lowercased)
//   name:  Google display name (best-effort)
//   iat / exp: standard
//   iss / aud: "tesserix-home" (so the cookie isn't valid against any
//                                other surface that re-uses the key)

import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { bearerToken } from "./bearer";

const ISSUER = "tesserix-home";
const AUDIENCE = "tesserix-home-admin";

export interface SessionClaims {
  sub: string;
  email: string;
  name?: string;
  /**
   * Capability keys granted by the identity provider — see `capabilities.ts`.
   *
   * Optional, and absent for every session minted by the legacy Google flow.
   * Absence therefore means "this session predates role-based authorization",
   * NOT "this operator holds no capabilities": treating it as the latter would
   * lock every signed-in operator out the moment this field shipped. Consumers
   * decide how to read absence, gated on `AUTH_PROVIDER`.
   */
  roles?: readonly string[];
}

interface VerifiedSession extends SessionClaims {
  iat: number;
  exp: number;
}

function getSecretKey(): Uint8Array {
  const raw = process.env.SESSION_ENCRYPT_KEY;
  if (!raw) {
    throw new Error("SESSION_ENCRYPT_KEY is not set");
  }
  // The chart provisions exactly 32 ASCII chars (24 bytes base64). For
  // A256GCM jose wants exactly 32 bytes of key material. Hash with
  // SHA-256 to land at 32 bytes regardless of input length, so we don't
  // care if a future operator rotates to a longer/shorter ASCII string.
  const enc = new TextEncoder().encode(raw);
  if (enc.length === 32) return enc;
  // Best-effort: derive 32 bytes via SHA-256 when length differs.
  // `createHash` is imported statically at the top of the module: this package
  // is pre-bundled by tsup, and esbuild's ESM output rewrites a dynamic
  // `require()` into a shim that throws at runtime. Both consumers' middleware
  // declares `runtime: "nodejs"`, so a static node:crypto import is safe.
  return new Uint8Array(createHash("sha256").update(enc).digest());
}

const TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Read the `roles` claim back off a decrypted session.
 *
 * Returns `undefined` — meaning "no roles claim" — for anything that is not an
 * array of strings, including an array with a non-string element. A partially
 * valid array is rejected wholesale rather than filtered: silently dropping one
 * bad entry from an authorization list is how a capability goes missing without
 * anyone noticing.
 */
function readRoles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === "string")) return undefined;
  return value as string[];
}

export async function signSession(claims: SessionClaims): Promise<string> {
  const key = getSecretKey();
  return new EncryptJWT({
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    // Omitted entirely when undefined, so a legacy session stays byte-identical
    // to what the Google flow minted before this field existed.
    ...(claims.roles ? { roles: [...claims.roles] } : {}),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
    .encrypt(key);
}

export async function verifySession(
  token: string,
): Promise<VerifiedSession | null> {
  try {
    const key = getSecretKey();
    const { payload } = await jwtDecrypt(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : undefined,
      // A malformed `roles` is treated as ABSENT, not as empty. Empty would
      // read as "holds nothing" and deny; absent lets the caller apply its
      // legacy-session policy. Denial on corruption belongs to the consumer,
      // which knows whether roles are expected at all.
      roles: readRoles(payload.roles),
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// Convenience for server actions / route handlers that need the
// authenticated super-admin's identity (e.g. to attribute a ticket
// reply to author_email + author_name). Middleware already gates the
// route so the session is guaranteed valid by the time we get here —
// this is just for reading the claims.
export async function getCurrentSession(): Promise<VerifiedSession | null> {
  // Lazy import keeps this usable only inside RSC / route-handler contexts,
  // where cookies() and headers() are available.
  const { cookies, headers } = await import("next/headers");
  const jar = await cookies();
  const cookieToken = jar.get(sessionCookieName())?.value;
  if (cookieToken) return verifySession(cookieToken);
  // Mobile clients hold no .tesserix.app cookie — they present the same
  // encrypted session (minted by /api/auth/mobile/google) as a bearer token.
  const bearer = bearerToken((await headers()).get("authorization"));
  if (bearer) return verifySession(bearer);
  return null;
}

export function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? "tx_session";
}

export interface SessionCookieOptions {
  domain: string;
  maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  return {
    domain: process.env.SESSION_COOKIE_DOMAIN ?? ".tesserix.app",
    maxAge: TOKEN_LIFETIME_SECONDS,
  };
}
