---
id: 260820-p6f
slug: platform-api-conventions-s10-refresh
date: 2026-08-20
---

# Correct §10 of docs/PLATFORM-API-CONVENTIONS.md

§0 states: where this doc and the code disagree, the code is right and the doc
is a bug. Three claims in §10 are now bugs by that rule.

1. The blockquote and the sentence after it say the callback drops
   `access_token`/`refresh_token`, `SessionClaims` has nowhere to put one, and
   `platform-token.ts` "returns null today". #297/#298 changed all three.
2. Step 1 says a refreshed token is not written back to the session. The tokens
   left the cookie entirely (migration 0029, `operator_api_tokens` keyed by
   `sid`); write-back is a row UPDATE under the refresh transaction's lock and
   works. No response object is needed, so the `middleware.ts` caveat is moot.
3. Step 2 says Zitadel "issues no refresh token" because the grant is absent.
   That is factually wrong and is the substance of #304: Zitadel ISSUES one
   (observed `hasRefreshToken: true`) and refuses to REDEEM it. Issuing and
   redeeming are separate permissions — the distinction is the whole bug.

Step 2 is now done: the Refresh Token grant was enabled on `console-web` today
and the grant-level refusal is gone (probe moved from `unauthorized_client:
grant_type "refresh_token" not allowed` to a token-level `invalid_grant`).

## Task

Single edit to `docs/PLATFORM-API-CONVENTIONS.md` §10. Docs only, no code.
