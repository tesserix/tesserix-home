// session-cookie-size.ts — how big the session cookie is, and whether the
// browser will actually keep it.
//
// # Why this exists
//
// A cookie over the browser's per-cookie limit is not truncated and not
// rejected with an error the server can see. Chrome simply DROPS the
// `Set-Cookie` header and says nothing to the origin. The server logs a
// successful login; the browser has no session; middleware bounces the
// operator back to `/auth/login`; the loop ends in ERR_TOO_MANY_REDIRECTS with
// every server-side signal reading green.
//
// That is not a hypothetical. It is exactly how console login failed
// (`.planning/debug/console-login-state-mismatch.md`): `/auth/callback` logged
// `session minted` seven times in ten seconds while the browser kept none of
// them, because the session JWE carried the Zitadel access and refresh tokens
// and cleared 4096 bytes.
//
// The only defence against a silent client-side drop is to measure the thing
// before handing it over. Every mint site should run the value past
// `measureSessionCookie` and refuse — loudly, with the byte count — rather
// than set a cookie the browser is going to discard.

/**
 * The browser's per-cookie ceiling, in bytes.
 *
 * RFC 6265bis asks user agents to accept at least 4096 bytes for the name,
 * value and attributes combined; Chrome, Firefox and Safari all implement a
 * 4096-byte limit on the NAME PLUS VALUE specifically. Chrome's wording:
 * "the combined size of the name and value must be less than or equal to 4096
 * characters". Attributes (`Path`, `Domain`, `Max-Age`, ...) are not counted,
 * so neither does this.
 */
export const SESSION_COOKIE_MAX_BYTES = 4096;

/**
 * How much of the ceiling may be used before this is worth shouting about.
 *
 * 90%. The gap has to absorb what varies between operators and cannot be seen
 * at review time — the length of an email address, a display name, and one
 * capability string per granted role. An operator with more roles than
 * whoever tested the deploy is precisely how a cookie that fit in staging
 * stops fitting in production, so the alarm has to fire before the ceiling,
 * not at it.
 */
export const SESSION_COOKIE_WARN_RATIO = 0.9;

/** Byte count above which a mint is near the ceiling and should be reported. */
export const SESSION_COOKIE_WARN_BYTES = Math.floor(
  SESSION_COOKIE_MAX_BYTES * SESSION_COOKIE_WARN_RATIO,
);

export interface SessionCookieMeasurement {
  /** Bytes of `name` + `value`, UTF-8, excluding the `=` and any attributes. */
  readonly bytes: number;
  /** `SESSION_COOKIE_MAX_BYTES`, carried so a log line is self-describing. */
  readonly limit: number;
  /** `SESSION_COOKIE_WARN_BYTES`, likewise. */
  readonly warnAt: number;
  /** Bytes still available under the limit. Negative when over it. */
  readonly headroom: number;
  /** The browser will discard this cookie. */
  readonly exceedsLimit: boolean;
  /** Not over the limit yet, but close enough that a bigger claim set would be. */
  readonly nearLimit: boolean;
}

/**
 * Measure a cookie against the limit the browser enforces silently.
 *
 * Counts UTF-8 BYTES rather than `String.length`, because a display name can
 * hold non-ASCII and the browsers count octets. A JWE is ASCII, so the two
 * agree for the value itself — but the name comes from configuration, and
 * agreeing by accident is not the same as being right.
 *
 * Returns a frozen description and never throws: it is called on the mint path
 * of the login flow, where a measurement that can fail is worse than no
 * measurement at all. The CALLER decides what to do about the answer.
 */
export function measureSessionCookie(
  name: string,
  value: string,
): SessionCookieMeasurement {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(name).length + encoder.encode(value).length;
  return Object.freeze({
    bytes,
    limit: SESSION_COOKIE_MAX_BYTES,
    warnAt: SESSION_COOKIE_WARN_BYTES,
    headroom: SESSION_COOKIE_MAX_BYTES - bytes,
    exceedsLimit: bytes > SESSION_COOKIE_MAX_BYTES,
    nearLimit: bytes > SESSION_COOKIE_WARN_BYTES,
  });
}
