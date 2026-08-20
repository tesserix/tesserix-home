import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import {
  measureSessionCookie,
  signSession,
  sessionCookieName,
  sessionCookieOptions,
  verifyIdToken,
  isInternal,
  capabilitiesFor,
  isPlatformOperator,
} from "@tesserix/platform-auth";

import {
  callbackRetryEnabled,
  describeCallbackRequest,
  retryRefusal,
} from "@/lib/auth/callback-diagnostics";
import {
  decodeState,
  exchangeCode,
  getOidcConfig,
  type TokenResponse,
} from "@/lib/auth/oidc";
import {
  accessTokenExpiresAt,
  saveTokens,
} from "@/lib/auth/operator-token-store";
import { withDeadline } from "@/lib/auth/deadline";
import { publicOrigin } from "@/lib/public-origin";

// GET /auth/callback — finish the OIDC flow and mint the session.

export const runtime = "nodejs";

const STATE_COOKIE = "cx_oauth_state";
const NONCE_COOKIE = "cx_oidc_nonce";

/**
 * How long the token-store write may run before this login stops waiting on
 * it.
 *
 * `saveTokens` is awaited with no deadline of its own, and nothing bounds a
 * query that has already started: `connectionTimeoutMillis` in
 * `lib/db/tesserix.ts` bounds POOL ACQUISITION only, and there is no
 * `statement_timeout` anywhere in this stack. An unreachable-but-not-refusing
 * Postgres, or an INSERT blocked on a lock, would otherwise stall this
 * response — and the operator's login — for as long as the query hangs. The
 * pool path also runs an opportunistic table-wide `pruneExpired()` DELETE
 * right after the INSERT (see `saveTokens`'s own JSDoc), so this deadline is
 * guarding two statements on the login critical path, not one.
 *
 * `withDeadline` REJECTS past this many milliseconds rather than resolving —
 * see its JSDoc in `lib/auth/deadline.ts` — which is exactly what lets
 * the timeout fall into the same `catch` a thrown store error falls into
 * below: a hang degrades identically to a throw, not differently from one.
 *
 * ACCEPTED COST: a slow-but-alive database now fails the token write at 2s
 * instead of eventually succeeding. That session gets "platform API
 * unreachable" (every caller of `getPlatformApiToken()` already handles this)
 * until the operator signs in again. That is strictly better than a login
 * that hangs — this is the exact path that was down for a day, and to an
 * operator a hung login is indistinguishable from that outage.
 */
const SAVE_TOKENS_DEADLINE_MS = 2_000;

/**
 * What the deadline above rejects with, and the only way to tell a hang apart
 * from a failure at the catch below.
 *
 * The distinction is not cosmetic. `saveTokens` runs an opportunistic
 * table-wide `pruneExpired()` DELETE AFTER its INSERT has already committed
 * (see its JSDoc), so a deadline that fires during the prune means the row is
 * almost certainly there. Logging both cases as "failed to store" tells the
 * 2am reader the tokens are missing when they are probably fine — a false
 * negative that sends them looking for the wrong outage.
 */
const SAVE_TOKENS_TIMEOUT_MESSAGE = "operator token store save timed out";

function failure(reason: string, status = 401): NextResponse {
  // Deliberately terse to the browser, detailed in the log. The operator does
  // not need to know which check failed; whoever reads the logs does.
  return NextResponse.json({ error: reason }, { status });
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;

  const oauthError = params.get("error");
  if (oauthError) {
    console.error("[auth/callback] provider returned an error", {
      error: oauthError,
      description: params.get("error_description"),
    });
    return failure("provider_error");
  }

  const code = params.get("code");
  if (!code) return failure("missing_code");

  const state = decodeState(params.get("state"));
  if (!state) return failure("bad_state");

  // CSRF: the nonce in `state` must match the httpOnly cookie set at /auth/login.
  // Without this an attacker can feed the browser a code of their choosing and
  // have the console mint a session for THEIR identity.
  // The CSRF check: the nonce inside `state` must match the httpOnly cookie
  // /auth/login set. Without it an attacker can feed the browser a code of
  // their choosing and have the console mint a session for THEIR identity.
  //
  // The two ways this fails are logged apart, because they have completely
  // different fixes and the single "state_mismatch" that used to cover both
  // cost an afternoon:
  //
  //   ABSENT  — this browser never visited /auth/login, or did so more than
  //             STATE_MAX_AGE ago. Landing straight on an authorize URL (a
  //             bookmark, a pasted link, a stale tab) does exactly this.
  //   DIFFERS — a login was started more than once and an OLDER tab was
  //             completed: each /auth/login overwrites the cookie, so the
  //             newest one no longer matches the state the old tab carries.
  //
  // Only the log distinguishes them; the response deliberately does not, so a
  // probe cannot learn whether a given browser has a live login in flight.
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie) {
    const origin = publicOrigin(request);
    // Held in a const rather than spread inline: the same description both
    // goes in the log and decides whether this request may be retried, and
    // reading the headers twice could disagree with itself. It is frozen by
    // construction — nothing here writes to it.
    const shape = describeCallbackRequest(request, {
      sessionCookie: sessionCookieName(),
      origin,
    });
    const refusal = retryRefusal(shape, {
      enabled: callbackRetryEnabled(),
      retried: state.retried,
    });

    console.warn("[auth/callback] no state cookie", {
      reason: "absent",
      hint: "this browser did not start at /auth/login, or the cookie expired",
      retried: state.retried,
      // Why this request was not healed — "speculative" and "not_a_navigation"
      // are findings, not mere refusals. See callback-diagnostics.ts.
      retryRefusal: refusal,
      // Names and presence only — never a cookie VALUE. See
      // lib/auth/callback-diagnostics.ts for what each field is asking.
      ...shape,
    });

    // Self-healing, exactly once, and only when explicitly switched on.
    //
    // The common cause of `absent` is benign: a browser that arrived on an
    // authorize URL without ever visiting /auth/login — a bookmark, a pasted
    // link, a tab left open past STATE_MAX_AGE. Dead-ending that on JSON tells
    // an operator nothing and leaves them stuck; one more trip through
    // /auth/login fixes it silently.
    //
    // Three things have to hold before that bounce is safe, and all three live
    // in retryRefusal():
    //
    //   ENABLED       — CONSOLE_CALLBACK_RETRY is opt-in, default off, because
    //                   the writer of the guard (/auth/login) may not be on
    //                   every pod yet during a rollout.
    //   NOT RETRIED   — `state.retried` came back from Zitadel inside `state`,
    //                   so it is readable even on the requests where no cookie
    //                   arrives, which is precisely the condition being
    //                   recovered from. A cookie-based marker would be missing
    //                   on those same requests, fail open, and spin forever.
    //   A NAVIGATION  — a speculative prefetch is cookieless by design;
    //                   bouncing one would re-run /auth/login behind the
    //                   operator's back and overwrite the cookies of a login
    //                   that was working.
    //
    // At most ONE extra round trip, then the error below.
    if (refusal === null) {
      const retry = new URL("/auth/login", origin);
      retry.searchParams.set("returnTo", state.returnTo);
      retry.searchParams.set("retry", "1");
      return NextResponse.redirect(retry);
    }

    // A retry that came back just as cookieless is not a stale tab — it is the
    // open bug, and looping on it would only make it harder to see.
    if (refusal === "already_retried") {
      console.error(
        "[auth/callback] retry also arrived without a state cookie",
        { reason: "absent_after_retry" },
      );
    }
    return failure("state_mismatch");
  }
  if (stateCookie !== state.nonce) {
    console.warn("[auth/callback] state cookie does not match", {
      reason: "differs",
      hint: "an older login tab was completed after a newer one was started",
    });
    return failure("state_mismatch");
  }

  let config;
  try {
    config = getOidcConfig();
  } catch (err) {
    console.error("[auth/callback] Zitadel config missing", err);
    return failure("auth_misconfigured", 500);
  }

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(config, code);
  } catch (err) {
    console.error("[auth/callback] token exchange failed", err);
    return failure("token_exchange_failed");
  }
  const idToken = tokens.id_token;
  if (!idToken) return failure("no_id_token");

  // Replay protection: the nonce we generated at /auth/login must come back
  // inside the token, so a stolen or replayed code cannot mint a session.
  const expectedNonce = request.cookies.get(NONCE_COOKIE)?.value;
  if (!expectedNonce) return failure("missing_nonce");

  // VERIFY, never decode. The token carries the roles that decide whether this
  // operator may rotate live payment keys or move money; that has to be
  // cryptographically attributable to Zitadel, not merely well-formed.
  let identity;
  try {
    identity = await verifyIdToken(
      idToken,
      {
        issuer: config.issuer,
        clientId: config.clientId,
        internalOrgId: config.internalOrgId,
      },
      expectedNonce,
    );
  } catch (err) {
    console.error("[auth/callback] id_token verification failed", err);
    return failure("invalid_id_token");
  }

  // An allowlisted platform operator is admitted without a project role grant,
  // but never without the org check: `email` in the token is not proven
  // verified, so the internal tenant stays the trust anchor.
  const inInternalOrg =
    !config.internalOrgId || identity.orgId === config.internalOrgId;
  const admitted =
    isInternal(identity, { internalOrgId: config.internalOrgId }) ||
    (inInternalOrg && isPlatformOperator(identity.email));
  if (!admitted) {
    // Authenticated, but not an internal operator — no roles on the Platform
    // Console project, or a member of another organization. 403 rather than
    // 401: signing in again would produce the same result.
    console.warn("[auth/callback] refused a non-internal identity", {
      sub: identity.sub,
      orgId: identity.orgId,
      roleCount: identity.roles.length,
    });
    return failure("not_internal", 403);
  }

  // Minted once, held in a variable, and used twice: as the session's `sid`
  // claim below, and as the key `saveTokens` writes the Zitadel tokens under
  // further down. Generating it twice would mint a cookie whose `sid` names a
  // row that was never written.
  const sid = randomBytes(16).toString("hex");

  const token = await signSession({
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    // Narrow to known capabilities before they reach the session: an
    // unrecognised role cannot be checked meaningfully, and carrying it invites
    // code elsewhere to match on a string the capability model never sanctioned.
    roles: capabilitiesFor(identity.email, identity.roles),
    // THE ZITADEL ACCESS AND REFRESH TOKENS ARE DELIBERATELY NOT HERE.
    //
    // They were, for ADR-003 D8, and it broke console login outright. The
    // browser enforces a 4096-byte per-cookie limit by DISCARDING the whole
    // `Set-Cookie` without telling the origin; with ten roles the encrypted
    // payload cleared it. This handler logged `session minted` seven times in
    // ten seconds while the browser kept none of them, and the operator got
    // ERR_TOO_MANY_REDIRECTS. See
    // `.planning/debug/console-login-state-mismatch.md`.
    //
    // So the cookie carries IDENTITY only, and the credentials move to a
    // server-side store keyed by `sid` below, read on the requests that
    // actually call the platform API rather than on every request. That store
    // is step 2 and is not built yet; until it lands
    // `getPlatformApiToken()` returns null, which every caller already
    // handles — see `lib/auth/platform-token.ts`.
    //
    // Do not put a token back in here to "just make the tickets module work".
    // The guard below will refuse to mint it and login will fail loudly, which
    // is the improvement.
    //
    // `sid` is minted here even though nothing reads it yet: it is the key
    // the token-store row will be found by, the same CSPRNG pattern
    // /auth/login already uses for its state/nonce cookies. Adds ~40 bytes to
    // a cookie currently measuring 499 — the size guard below still applies
    // and is the thing that would catch it if that ever stopped being true.
    sid,
  });

  // The browser's silent 4096-byte drop is what made this bug invisible for a
  // day: the server saw seven successful logins and the browser had no cookie.
  // Measure before handing it over, so the failure can never be silent again.
  const fit = measureSessionCookie(sessionCookieName(), token);
  if (fit.exceedsLimit) {
    // REFUSE rather than mint. Setting it anyway reproduces the original bug
    // exactly — the browser discards it, middleware bounces back to
    // /auth/login, and the loop ends in ERR_TOO_MANY_REDIRECTS with every
    // server-side signal green. A 500 with this line in the log is a bug an
    // operator can report and an engineer can act on in a minute.
    console.error("[auth/callback] session cookie exceeds the browser limit", {
      sub: identity.sub,
      roleCount: identity.roles.length,
      bytes: fit.bytes,
      limit: fit.limit,
      overBy: -fit.headroom,
      hint: "the browser would discard this Set-Cookie silently; the session was not issued",
    });
    return failure("session_too_large", 500);
  }
  if (fit.nearLimit) {
    // Still works, for this operator. The next one with more roles is the one
    // it stops working for, and by then nobody is looking. error, not warn:
    // this is a countdown to an outage, not a curiosity.
    console.error(
      "[auth/callback] session cookie is close to the browser limit",
      {
        sub: identity.sub,
        roleCount: identity.roles.length,
        bytes: fit.bytes,
        warnAt: fit.warnAt,
        limit: fit.limit,
        headroom: fit.headroom,
        hint: "an operator with more roles will exceed 4096 bytes and be unable to sign in",
      },
    );
  }

  // The success line, so the logs can tell "no callback ever completed" apart
  // from "one completed and a later one failed". Without it, the absence of a
  // failure is the only evidence a login worked, and that is not evidence.
  // `sub` identifies the operator; no token, no cookie value, no code. The
  // byte count is here too — a size that creeps up release by release is only
  // visible if it is recorded when nothing is wrong.
  console.info("[auth/callback] session minted", {
    sub: identity.sub,
    retried: state.retried,
    roleCount: identity.roles.length,
    cookieBytes: fit.bytes,
    cookieLimit: fit.limit,
  });

  // Computed here — rather than where it is used below, on the redirect
  // response — because `saveTokens` needs `maxAge` too: `session_expires_at`
  // is supposed to mirror the session cookie's own lifetime, and reading it
  // from the one call site that already exists keeps that true by
  // construction instead of by two numbers agreeing on trust.
  const cookie = sessionCookieOptions();

  // Write the platform-API tokens the exchange just returned into the store,
  // keyed by the `sid` already minted into the session above.
  //
  // THE ASYMMETRY THAT MATTERS: the size guard above REFUSES to mint a
  // session when the cookie would break login, because breaking login is not
  // an option. This call is the mirror image and must resolve the opposite
  // way — it must never be allowed to refuse a login. Reaching the platform
  // API is an optional capability layered on top of a session that already
  // exists; the database being down, the encryption key being unset, or this
  // INSERT failing outright must degrade to "no platform API this session"
  // (which every reader of `getPlatformApiToken()` already treats as a normal
  // outcome), not to "no login". Coupling the two would turn an ordinary
  // database blip into an outage of the entire console over a capability most
  // pages never touch. It must also never make the operator WAIT — see
  // `SAVE_TOKENS_DEADLINE_MS` above for the hang half of this guarantee.
  if (tokens.access_token) {
    try {
      await withDeadline(
        saveTokens(
          sid,
          identity.sub,
          {
            accessToken: tokens.access_token,
            accessExpiresAt: accessTokenExpiresAt(tokens.expires_in),
            // `?? null`, not `?? ""`: Zitadel omitting a refresh token must
            // be stored as "no refresh token"
            // (`OperatorTokensInput.refreshToken` is `string | null |
            // undefined`), never as an empty string that would later decrypt
            // to a token nothing issued.
            refreshToken: tokens.refresh_token ?? null,
          },
          new Date(Date.now() + cookie.maxAge * 1000),
        ),
        SAVE_TOKENS_DEADLINE_MS,
        SAVE_TOKENS_TIMEOUT_MESSAGE,
      );
    } catch (cause) {
      // Either a thrown error (see `saveTokens`'s JSDoc — it already
      // swallows pool-path errors and returns, but this call site does not
      // lean on that alone) or the deadline above rejecting a hang. Both mean
      // the same thing to THIS CALLER: the login proceeds exactly as if the
      // store did not exist.
      //
      // They do not mean the same thing to whoever reads the log, so they do
      // not share a line. A timeout leaves the row's fate genuinely unknown —
      // and, because the prune runs after the INSERT commits, more likely
      // written than not.
      const timedOut =
        cause instanceof Error && cause.message === SAVE_TOKENS_TIMEOUT_MESSAGE;
      console.error(
        timedOut
          ? "[auth/callback] platform API token store timed out; the row may or may not have been written"
          : "[auth/callback] failed to store platform API tokens",
        { sub: identity.sub, sid },
      );
    }
  } else {
    // Zitadel can return an id_token without an access_token depending on
    // grant configuration. Not fatal — the session is still minted below —
    // but worth a line, since it means this operator's session cannot reach
    // the platform API until they sign in again with it fixed.
    console.warn(
      "[auth/callback] token exchange returned no access token; platform API unreachable this session",
      { sub: identity.sub, sid },
    );
  }

  // publicOrigin, NOT nextUrl.origin: behind the ingress the latter is the pod's
  // own bind address, so this redirect shipped the browser to
  // http://0.0.0.0:3000 — the third time this codebase has made that mistake.
  const res = NextResponse.redirect(
    new URL(state.returnTo, publicOrigin(request)),
  );
  res.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: new URL(config.redirectUri).protocol === "https:",
    sameSite: "lax",
    path: "/",
    domain: cookie.domain,
    maxAge: cookie.maxAge,
  });
  // One-shot values: leaving them set would let a stale nonce satisfy a later
  // callback.
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(NONCE_COOKIE);
  return res;
}
