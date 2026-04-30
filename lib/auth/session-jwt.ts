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

import { EncryptJWT, jwtDecrypt } from "jose";

const ISSUER = "tesserix-home";
const AUDIENCE = "tesserix-home-admin";

export interface SessionClaims {
  sub: string;
  email: string;
  name?: string;
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
  // This is dynamic-import-safe (Edge runtime would need crypto.subtle,
  // but middleware now runs on Node so plain Node crypto is available).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return new Uint8Array(createHash("sha256").update(enc).digest());
}

const TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function signSession(claims: SessionClaims): Promise<string> {
  const key = getSecretKey();
  return new EncryptJWT({
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
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
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
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
