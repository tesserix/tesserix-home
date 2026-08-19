---
status: investigating
trigger: |
  Console login fails with {"error":"state_mismatch"} — /auth/callback logs reason:'absent'
  (no cx_oauth_state cookie) even on a fresh incognito run, preceded by an
  ERR_TOO_MANY_REDIRECTS loop.
created: 2026-08-20
updated: 2026-08-20
---

# console-login-state-mismatch

## Symptoms

**Expected behavior**
An operator opens https://console.tesserix.app, is redirected through Zitadel,
signs in, and lands back in the console with a `tx_session` cookie minted.

**Actual behavior**
After signing in, the browser goes through an ERR_TOO_MANY_REDIRECTS loop and
then lands on `/auth/callback` rendering `{"error":"state_mismatch"}`. No
`tx_session` is ever minted.

**Error messages**
- Browser: `{"error":"state_mismatch"}` (HTTP 401)
- Browser, preceding it: `ERR_TOO_MANY_REDIRECTS` on auth.tesserix.app
- Pod (`tesserix/console`): `[auth/callback] no state cookie { reason: 'absent',
  hint: 'this browser did not start at /auth/login, or the cookie expired' }`

**Timeline**
Ongoing since the Zitadel cutover. Several attempted fixes have not resolved it
(state cookie lifetime raised 10 -> 30 min in 45da1ef; org scope pinned in
7c83183). Still failing 2026-08-20.

**Reproduction**
1. Fresh incognito window (confirmed fresh by the user — not a stale tab).
2. Navigate to https://console.tesserix.app
3. Redirected via /auth/login -> /oauth/v2/authorize -> Zitadel V1 hosted UI
4. Sign in
5. Redirect loop, then `{"error":"state_mismatch"}`

## Environment

- Deployed image: `tesserix-console:main-17db0b4` (deployment revision 62,
  `tesserix` namespace, GKE `tesseract-prod-in-gke`, kubeconfig `~/.kube/gke-prod`)
- Zitadel `console-web` application is on **Login V1** — authorize lands at
  `auth.tesserix.app/ui/login/login?authRequestID=...`
- The console's own `/login` page (PR #295) is deployed but **inert**: Zitadel does
  not route to it, and `ZITADEL_LOGIN_CLIENT_TOKEN` is absent from `console-secrets`
  (which holds only `SESSION_ENCRYPT_KEY` and `ZITADEL_CLIENT_SECRET`).
- Edge chain: Cloudflare -> Istio (`tesseract-gateway`) -> `console-vs` -> console svc

## Evidence

- timestamp: 2026-08-20 (live prod, curl)
  finding: `/auth/login` sets both cookies correctly — `cx_oauth_state` and
  `cx_oidc_nonce`, `Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=lax`.
  Three consecutive requests returned three distinct state values, all with
  `cf-cache-status: DYNAMIC`. The redirect is NOT cached and the state is fresh.
  Note: the 307 carries no `Cache-Control` header at all (latent risk, not the
  active cause).

- timestamp: 2026-08-20 15:31:48Z (live prod)
  finding: Sent a deliberately wrong cookie to `/auth/callback` from the user's
  browser (new tab, same incognito window). Pod logged `reason: 'differs'`.
  PROVES: cookies traverse Cloudflare + Istio to the pod intact, the edge is not
  stripping the Cookie header, and the cookie WAS in the jar at that moment.

- timestamp: 2026-08-20 15:32:30Z (live prod)
  finding: 42 seconds later, the real callback for the same browser logged
  `reason: 'absent'`. Cookie went from present to absent with only the Zitadel
  sign-in occurring in between.

- timestamp: 2026-08-20 (DevTools, failing request headers)
  finding: The failing `/auth/callback` request is `:method GET`,
  `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`,
  `Sec-Fetch-Site: same-site`. Its `Cookie:` header contains ONLY `cf_clearance`
  — no `cx_oauth_state`, no `cx_oidc_nonce`. A `SameSite=Lax` cookie IS sent on
  top-level same-site GET navigations, so the cookie was simply not in the jar.
  `cf_clearance` is `Domain=.tesserix.app` so it rides along; the console cookies
  are host-only.

- timestamp: 2026-08-20 (DevTools, cookie jar after a failure)
  finding: `cx_oauth_state` and `cx_oidc_nonce` present on console.tesserix.app,
  and NO `tx_session`. So no callback ever succeeded — rules out "a first
  callback succeeded, deleted the cookies, and this is a duplicate request".

- timestamp: 2026-08-20 (DevTools network waterfall, clean run)
  finding: The chain is `console.tesserix.app 307` -> `/auth/login?returnTo=%2F
  307` -> `/oauth/v2/authorize 302` -> `/ui/login/login 200`. Exactly ONE
  `/auth/login` — no duplicate overwriting the cookie on the way in.

- timestamp: 2026-08-20 (live prod, curl — testing the cross-host lead)
  finding: The live authorize 302 from `/auth/login?returnTo=%2F` carries
  `redirect_uri=https%3A%2F%2Fconsole.tesserix.app%2Fauth%2Fcallback`. The
  callback host is the SAME host that set `cx_oauth_state` in the same response.

- timestamp: 2026-08-20 (k8s, deploy/console env)
  finding: `CONSOLE_PUBLIC_ORIGIN` is UNSET, so `publicOrigin()` falls through to
  its `DEFAULT_ORIGIN` of `https://console.tesserix.app` — which is the right
  answer. `ZITADEL_REDIRECT_URI=https://console.tesserix.app/auth/callback`,
  `ZITADEL_ISSUER=https://auth.tesserix.app`, `NODE_ENV=production`. No env var
  can steer either the authorize redirect_uri or the post-login redirect to a
  host other than console.tesserix.app.

- timestamp: 2026-08-20 (git)
  finding: The working tree at `feat/console-login-page` is byte-identical to
  deployed `origin/main` (17db0b4) for `app/auth/callback/route.ts`,
  `app/auth/login/route.ts`, `lib/public-origin.ts` and `middleware.ts`. The
  code being read IS the code running.

- timestamp: 2026-08-20 (reasoning, from the elimination below)
  finding: `Sec-Fetch-Site: same-site` on the failing callback is NOT anomalous
  and is not evidence of a cross-host request. auth.tesserix.app ->
  console.tesserix.app is cross-ORIGIN but same-SITE, which is exactly what a
  normal Zitadel redirect produces. This header was over-read.

- timestamp: 2026-08-20 (TypeScript review of the shipped retry)
  finding: The one-shot guard has a READER (`app/auth/callback/route.ts`) and a
  WRITER (`app/auth/login/route.ts`, which turns `?retry=1` into the third
  `state` segment). They ship in one commit but do NOT start serving in one
  instant. Mid-rollout: new callback -> 307 `/auth/login?retry=1` -> an OLD
  login pod ignores `retry` and mints a 2-segment state -> Zitadel already has a
  session, so it bounces straight back -> the new callback reads
  `retried === false` again and retries again. Unbounded, for as long as login
  requests keep landing on old pods. Since "no cookie arrives" is the ACTIVE
  bug, this is the common path, not a corner. Closed by making the retry
  opt-in via `CONSOLE_CALLBACK_RETRY`, default OFF: the first deploy carries
  the reader inert, so no pod ordering can redirect at all.

- timestamp: 2026-08-20 (same review)
  finding: The retry as first written fired for ANY cookieless callback,
  including a speculative prefetch/prerender — which is the LEADING hypothesis
  in Current Focus, and is cookieless BY DESIGN. Following it would run
  `/auth/login`, overwrite `cx_oauth_state`/`cx_oidc_nonce`, and convert a
  login working in another tab into the `differs` failure. So the retry would
  have manufactured the second failure mode while hiding the evidence for the
  first. Now gated on `secFetchMode === "navigate"` with no `Sec-Purpose` /
  `Purpose` header; a refused request is LOGGED (`retryRefusal:
  "speculative" | "not_a_navigation" | "already_retried" | "disabled"`) rather
  than healed, which turns the refusal itself into the discriminating datum.

- timestamp: 2026-08-20 (k8s)
  finding: `SESSION_ENCRYPT_KEY` is 32 bytes and present; `SESSION_COOKIE_NAME`
  (`tx_session`) and `SESSION_COOKIE_DOMAIN` (`.tesserix.app`) match what
  `packages/platform-auth/src/session-jwt.ts` reads. Session sign/verify config
  is consistent.

## Eliminated

- hypothesis: The cookie expired (STATE_MAX_AGE too short).
  why: Present 42s before the failure; window is 30 minutes.

- hypothesis: Cloudflare/Istio strips the Cookie header.
  why: The wrong-cookie probe reached the pod and logged `differs`.

- hypothesis: Cloudflare caches the `/auth/login` 307, serving a stale state
  with no Set-Cookie.
  why: Three consecutive requests returned distinct state values,
  `cf-cache-status: DYNAMIC` every time.

- hypothesis: Cloudflare Speed Brain prefetches the callback uncredentialed.
  why: The zone rule is `href_matches: "/*", relative_to: "document"` —
  same-origin only. It would never prefetch console.tesserix.app from
  auth.tesserix.app.

- hypothesis: A stale tab / bookmarked authorize URL from an earlier attempt.
  why: User confirmed the failing run was a fresh incognito tab.

- hypothesis: Session key mismatch causes the middleware to reject a minted
  session, producing the redirect loop.
  why: `SESSION_ENCRYPT_KEY` present and consistent; and no `tx_session` is ever
  set, so the callback never reaches the minting step.

- hypothesis: Zitadel was flipped to Login V2 and loops against the console's
  `/login`.
  why: Authorize still lands at `/ui/login/login` (V1), and
  `console.tesserix.app/login?authRequest=TESTID` returns 200, not a redirect.

- hypothesis: The failing `/auth/callback` request went to a DIFFERENT host than
  the one that set the cookies (a `publicOrigin` failure putting a foreign host
  in `redirect_uri`), which would explain a cookieless callback because the
  console cookies are host-only while `cf_clearance` is `Domain=.tesserix.app`.
  why: DISPROVEN empirically. The live authorize 302 sends
  `redirect_uri=https://console.tesserix.app/auth/callback`, taken from
  `ZITADEL_REDIRECT_URI`, which is that exact literal on the pod — it never
  passes through `publicOrigin()` at all. `CONSOLE_PUBLIC_ORIGIN` is unset and
  the default is already the correct origin, so `publicOrigin()` cannot return a
  foreign host either. Every hop stays on console.tesserix.app. The supporting
  `Sec-Fetch-Site: same-site` observation is also void: auth -> console is
  same-site by definition, so that header is what a HEALTHY flow looks like.

- hypothesis: A Cloudflare managed challenge interrupts the flow.
  why: Browser-like requests to `/auth/login` and `/auth/callback` returned
  307/401 with no `cf-mitigated` header and no `cf_clearance` issued.

## Current Focus

hypothesis: Still open. With the cross-host lead disproven, ONE mechanism
  remains that reconciles the central contradiction — `cx_oauth_state` sitting
  in the jar for console.tesserix.app while a top-level GET navigation to that
  same host arrives carrying only `cf_clearance`. A `SameSite=Lax` host-only
  cookie IS sent on such a navigation, so the failing request was probably not
  the navigation we think it was. The two survivors:
    (a) it was an UNCREDENTIALED PREFETCH/PRERENDER, not a navigation. Only
        `Sec-Purpose`/`Purpose` distinguishes this, and no evidence gathered so
        far includes those headers. Note `speculation-rules:
        "/cdn-cgi/speculation"` IS present on live console responses.
    (b) the jar screenshot was taken AFTER the user navigated back to the
        console, which re-ran `/auth/login` and minted fresh cookies — so the
        jar shows a LATER attempt, not the failed one, and the contradiction is
        an artefact of evidence ordering rather than a real mechanism.
  Both are settled by one field in the log line, not by more reading.

test: SHIPPED, NOT YET RUN. `/auth/callback`'s `absent` branch now logs the
  received cookie NAMES, `tx_session` presence, host/forwarded-host/origin,
  `referer` (query stripped), and `sec-fetch-site|mode|dest` plus
  `sec-purpose`/`purpose`, alongside `retryRefusal` (why this request was not
  healed). A success line was added so "no callback ever completed" is
  distinguishable from "one completed and a later one failed".
  THE FIRST DEPLOY IS INSTRUMENTATION ONLY. `CONSOLE_CALLBACK_RETRY` is unset,
  so `retryRefusal` reads `"disabled"` and the callback behaves exactly as it
  does today — 401 `state_mismatch`, no redirect. That is deliberate: it means
  the experiment cannot be contaminated by the mitigation, and no rolling-update
  ordering can loop.

expecting:
  - `cookieNames` containing ONLY `cf_clearance` while `secPurpose`/`purpose`
    is set -> hypothesis (a), a speculative prefetch. Fix is a Cloudflare rule
    or `Cache-Control: no-store` on the route, not application logic.
  - `cookieNames` containing ONLY `cf_clearance` with all Sec-Purpose headers
    ABSENT and `secFetchMode: navigate` -> a genuine cookieless navigation to
    the correct host; the jar evidence was mis-ordered and the cookie really
    was gone. Next suspect becomes cookie eviction / the Zitadel V1 loop.
  - `cx_oauth_state` PRESENT in `cookieNames` on a failing request -> the
    request-level read is the broken thing, not the cookie.
  - `retryRefusal: "speculative"` on the failing line -> hypothesis (a) is
    confirmed outright, without the retry ever having fired.

next_action: USER DEPLOYS (Kargo, on merge to main) — INSTRUMENTATION ONLY, the
  retry stays off — reproduces the failure once, then reads
  `kubectl -n tesserix logs deploy/console --since=10m --timestamps |
  grep 'auth/callback'`. The mitigation is a SEPARATE, LATER step: set
  `CONSOLE_CALLBACK_RETRY=1` on `deploy/console` only once
  `kubectl -n tesserix get pods -l app=console -o
  jsonpath='{.items[*].spec.containers[0].image}'` shows one single image
  across every Running pod and nothing old still terminating — the precondition
  is that live state, not the merge and not a green Kargo stage.

## Planned change

STATUS: BOTH DELIVERED on `feat/console-login-page` (committed, NOT pushed).

1. **Instrument** the `absent` branch — DONE.
   `apps/console/lib/auth/callback-diagnostics.ts` (new) +
   `apps/console/app/auth/callback/route.ts`. Cookie NAMES and presence
   booleans only; no cookie values, no `code`, no tokens. `referer` is
   truncated to origin + path so a same-origin referer cannot carry an
   authorization code into the logs.

2. **Self-healing retry** with a one-shot guard — DONE, but SHIPPED OFF.
   `CONSOLE_CALLBACK_RETRY` ("1"/"true" to enable) is the master switch and it
   defaults to off, because the guard's writer (`/auth/login`) is not on every
   pod the moment the reader starts running. It also refuses to heal anything
   that is not a real top-level navigation, so a speculative prefetch is
   recorded rather than followed.
   The guard rides in the OIDC `state` parameter, not in a cookie. This was the
   critical design decision: the retry's precondition is "no cookie arrived",
   so a cookie-based marker would be absent on exactly the requests that must
   read it, fail open, and loop forever. `redirect_uri` could not carry it
   either (it must match Zitadel byte for byte). `state` round-trips through
   Zitadel by protocol, independent of the cookie jar.
   Encoding is backward compatible (`nonce.b64path` unchanged; optional third
   `.r` segment), so a login in flight during the rollout still parses. An
   unrecognised third segment is REJECTED rather than ignored, so a forged
   `state` cannot strip the guard and re-arm the retry.
   Bound: at most ONE extra round trip, then the original 401.
   `differs` untouched — still 401, as specified.

## Resolution

root_cause: NOT YET CONFIRMED. Narrowed to the two candidates in Current Focus;
  the shipped instrumentation is the experiment that separates them.
fix: Not yet — nothing shipped here claims to fix the root cause. The retry is
  a mitigation for the benign stale-tab case and must not be mistaken for one.
verification: Pending deploy + one reproduction.
files_changed:
  - apps/console/lib/auth/callback-diagnostics.ts (new; also the
    CONSOLE_CALLBACK_RETRY flag and the retryRefusal gate)
  - apps/console/lib/auth/callback-diagnostics.test.ts (new, 22 cases)
  - apps/console/lib/auth/oidc.ts (state carries the one-shot retry flag)
  - apps/console/lib/auth/oidc.test.ts (6 new cases)
  - apps/console/app/auth/login/route.ts (accepts ?retry=1)
  - apps/console/app/auth/callback/route.ts (instrumentation + guarded retry)
