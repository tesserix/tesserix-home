import type { NextRequest } from "next/server";

/**
 * What a cookieless `/auth/callback` request actually looked like.
 *
 * # Why this exists
 *
 * The console's callback fails with `reason: 'absent'` — no `cx_oauth_state` —
 * on runs where DevTools shows that cookie sitting in the jar for
 * console.tesserix.app. A `SameSite=Lax` host-only cookie IS sent on a
 * top-level same-site GET navigation, so those two observations cannot both
 * describe the same request. Something about the failing request differs from
 * the navigation we think we are looking at, and no amount of reading the code
 * has said what.
 *
 * So we stop guessing and record the shape of the request itself. The fields
 * here are chosen to discriminate between the surviving explanations:
 *
 *   cookieNames   — did ANY console cookie arrive, or only the `.tesserix.app`
 *                   domain cookies (`cf_clearance`) that ride to every host?
 *                   Only-domain-cookies means the host-only jar was not
 *                   consulted for this request at all.
 *   host /        — whether the request reached the same origin that set the
 *   forwardedHost   cookies. Host-only cookies do not cross hosts; a callback
 *   origin          landing on a sibling *.tesserix.app host would be
 *                   cookieless and would look exactly like this.
 *   referer       — which hop issued it. Zitadel's authorize endpoint, the
 *                   hosted login UI, and the console itself are three very
 *                   different stories.
 *   secFetch*     — `navigate`/`document` confirms a real top-level navigation.
 *                   Anything else means it was not one.
 *   secPurpose /  — a prefetch or prerender is issued WITHOUT credentials.
 *   purpose         That is the one mechanism that produces a cookieless
 *                   request while the cookie is genuinely in the jar, and it
 *                   is invisible in every other piece of evidence gathered so
 *                   far.
 *   hasSession    — a `tx_session` here would mean a callback fired after a
 *                   login had already succeeded.
 *
 * # What must never appear here
 *
 * NAMES AND PRESENCE ONLY. Never a cookie VALUE: `cx_oidc_nonce` is the OIDC
 * replay nonce and `tx_session` is a bearer credential — either one in a log
 * line is a credential in Cloud Logging, readable by everyone with log access
 * and retained long after the session it belongs to. The authorization `code`
 * and the tokens are excluded for the same reason.
 *
 * The referer is truncated to origin + path deliberately. `Referrer-Policy` is
 * `strict-origin-when-cross-origin`, so a cross-origin referer arrives as a
 * bare origin anyway and nothing is lost — but a SAME-origin referer would
 * carry a full query string, and on this route that can mean an authorization
 * code. Stripping the query costs no diagnostic value and closes that.
 */
export interface CallbackRequestShape {
  readonly cookieNames: ReadonlyArray<string>;
  readonly hasSession: boolean;
  readonly host: string | null;
  readonly forwardedHost: string | null;
  readonly origin: string;
  readonly referer: string | null;
  readonly secFetchSite: string | null;
  readonly secFetchMode: string | null;
  readonly secFetchDest: string | null;
  readonly secPurpose: string | null;
  readonly purpose: string | null;
}

/** Origin and path of a referer, with the query dropped. Null if unusable. */
function safeReferer(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    // A malformed Referer is itself worth knowing about, but the raw value is
    // attacker-supplied and unbounded — say that it was malformed instead.
    return "<unparseable>";
  }
}

export function describeCallbackRequest(
  request: NextRequest,
  options: { readonly sessionCookie: string; readonly origin: string },
): CallbackRequestShape {
  const header = (name: string): string | null => request.headers.get(name);

  return {
    // Sorted so two log lines can be compared by eye without the order of a
    // Cookie header getting in the way.
    cookieNames: request.cookies
      .getAll()
      .map((cookie) => cookie.name)
      .sort(),
    hasSession: request.cookies.has(options.sessionCookie),
    host: header("host"),
    forwardedHost: header("x-forwarded-host"),
    origin: options.origin,
    referer: safeReferer(header("referer")),
    secFetchSite: header("sec-fetch-site"),
    secFetchMode: header("sec-fetch-mode"),
    secFetchDest: header("sec-fetch-dest"),
    secPurpose: header("sec-purpose"),
    purpose: header("purpose"),
  };
}

/**
 * Master switch for the callback's self-healing retry. DEFAULT OFF.
 *
 * # Why a flag, and why off
 *
 * The retry has a reader (`/auth/callback`, which bounces to
 * `/auth/login?retry=1`) and a writer (`/auth/login`, which folds that into
 * `state` so the guard comes back). They ship in the same commit but they do
 * NOT start running in the same instant: during a rolling update some pods
 * serve the new image while others still serve the old one. A new callback
 * talking to an OLD login pod gets a two-segment `state` back with no retry
 * flag, so the guard reads "not yet retried" on every trip and the retry stops
 * being one-shot. Zitadel already has a session by then, so the bounce is
 * instant and the browser spins — the ERR_TOO_MANY_REDIRECTS this whole
 * investigation started from.
 *
 * Default-off closes that. The first deploy is instrumentation only: the
 * reader is present but inert, so no rollout ordering can produce a loop.
 *
 * # Ordering requirement for turning it on
 *
 * Enable this ONLY once the live system is in this state: EVERY pod behind
 * `deploy/console` is running the image that contains the writer — i.e.
 * `kubectl -n tesserix get pods -l app=console` shows a single image across
 * all Running pods and zero old-revision pods still terminating. That is the
 * precondition, not "the PR merged" and not "Kargo reported success": a merge
 * says nothing about which pods are serving traffic right now.
 */
const RETRY_ENV = "CONSOLE_CALLBACK_RETRY";

/** True only for an explicit opt-in. Anything else, including unset, is off. */
export function callbackRetryEnabled(
  raw: string | undefined = process.env[RETRY_ENV],
): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Why a cookieless callback was NOT retried, or null when it should be. */
export type RetryRefusal =
  | "disabled"
  | "already_retried"
  | "not_a_navigation"
  | "speculative";

/**
 * Decide whether a cookieless callback may be bounced back through
 * `/auth/login` once.
 *
 * Every refusal is named rather than folded into a bare `false`, because the
 * refusal is itself the diagnostic: "speculative" would confirm the leading
 * hypothesis (an uncredentialed prefetch, which is cookieless BY DESIGN and
 * must never be healed — following it would re-run `/auth/login`, overwrite
 * `cx_oauth_state`/`cx_oidc_nonce`, and turn a working login in another tab
 * into the `differs` failure).
 *
 * Returns null when the retry is allowed.
 */
export function retryRefusal(
  shape: CallbackRequestShape,
  options: { readonly enabled: boolean; readonly retried: boolean },
): RetryRefusal | null {
  if (!options.enabled) return "disabled";
  if (options.retried) return "already_retried";
  // A prefetch/prerender announces itself in one of two headers depending on
  // the browser's vintage. Either one present means: observe, do not heal.
  if (shape.secPurpose || shape.purpose) return "speculative";
  // Anything that is not a top-level navigation cannot be the login the
  // operator is sitting in front of, so redirecting it fixes nothing.
  if (shape.secFetchMode !== "navigate") return "not_a_navigation";
  return null;
}
