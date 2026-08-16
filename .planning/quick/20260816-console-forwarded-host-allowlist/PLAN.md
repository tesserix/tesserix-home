---
id: 260816-tmf
slug: console-forwarded-host-allowlist
date: 2026-08-16
issue: 184
status: complete
---

# Stop trusting client-supplied `X-Forwarded-Host` when building redirects

Closes #184.

## The defect

`publicOrigin()` (`apps/console/lib/public-origin.ts`) takes `X-Forwarded-Host`
from the request unconditionally, and the ingress passes the client's value
through rather than overwriting it. Reproduced against production:

```
$ curl -sD - -H "X-Forwarded-Host: evil.example.com" https://console.tesserix.app/ | grep -i ^location
location: https://evil.example.com/auth/login?returnTo=%2F
```

`apps/web/app/auth/callback/route.ts:29` carries its own copy of the same helper
with the same flaw, used for the `/login` error redirect and the post-login
destination.

Not urgent — a browser cannot be made to send that header from a link, form or
fetch, and the OIDC `redirect_uri` comes from the static `ZITADEL_REDIRECT_URI`
rather than from this helper, so tokens cannot be steered. It is a trusted-proxy
header being trusted from untrusted clients, and it stops being latent the
moment anyone derives an email link, a callback URL or a cache key from
something called "the public origin".

## Approach

Narrow, don't redesign. The helper keeps its shape and its reason for existing
(the pod's bind address is not a reachable host); it just stops believing an
arbitrary value.

**Allowlist, with the configured origin as the fallback.**

- Source of truth is `CONSOLE_PUBLIC_ORIGIN`, which already exists and is
  already the console's declared identity — `lib/platform-api.ts:175` uses it to
  name itself to `apps/web`'s CSRF gate, defaulting to
  `https://console.tesserix.app`. Reuse it rather than introducing a second
  origin variable that can drift from the first.
- Additional hosts come from an optional `CONSOLE_ALLOWED_HOSTS` (comma
  separated), for preview or alternate hostnames.
- **No `.tesserix.app` wildcard.** The issue floats one; reject it. A wildcard
  turns every current and future subdomain — including any that is ever parked,
  delegated or taken over — into a valid redirect target, which is most of the
  hole we are closing. Explicit hosts cost one env var.
- When the forwarded host matches the configured origin's host, return the
  **configured origin string itself** rather than reassembling
  `${proto}://${host}`. That drops the `X-Forwarded-Proto` trust in the same
  move: proto is no longer read from the request on the production path, so a
  forged `http` cannot produce a downgraded URL.
- Local dev must keep working. There is no proxy there, but there *is* a `Host`
  header (`localhost:3003`), so a bare allowlist would send developers to
  `console.tesserix.app`. Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`, any
  port) are accepted outside production, with the proto taken from
  `nextUrl.origin` so dev stays on `http`.
- A rejected host is not an error: fall back to the configured origin and carry
  on. Failing the request would turn a header nobody legitimately sends into a
  denial-of-service knob.

Apply the same narrowing to `apps/web`'s private copy, keyed off its existing
`NEXT_PUBLIC_SITE_URL`. `apps/web` is scheduled for deletion, but this is a
ten-line narrowing of a live redirect on the primary domain, not investment in
its features.

## Tasks

### 1. Narrow `apps/console/lib/public-origin.ts`

- Allowlist as described; configured origin returned verbatim on a match.
- Loopback exemption gated on `process.env.NODE_ENV !== "production"`.
- Keep the existing doc comment's explanation of *why* the helper exists and add
  the trust boundary to it.

### 2. Extend `apps/console/lib/public-origin.test.ts`

Existing five cases must still pass (they all use `console.tesserix.app`, which
is the default configured origin). Add:

- a forged host (`evil.example.com`) falls back to the configured origin — the
  exact curl above, as a test
- a forged host in a proxy chain (`evil.example.com, console.tesserix.app`)
  is rejected: only the first value is the client-facing one
- `X-Forwarded-Proto: http` on an allowed host still yields `https` (no
  downgrade)
- a host from `CONSOLE_ALLOWED_HOSTS` is accepted
- port and case are handled: `CONSOLE.tesserix.app` matches, `console.tesserix.app.evil.com` does not
- loopback is accepted in dev and **rejected when `NODE_ENV=production`**

### 3. Narrow `apps/web/app/auth/callback/route.ts`'s copy

Same rule against `NEXT_PUBLIC_SITE_URL` (default `https://tesserix.app`). Add a
test if the file has a reachable seam; if not, say so in the summary rather than
contorting the route to create one.

### 4. Verify

- `pnpm test` (or the console's vitest project) green, including the existing
  `redirect-origin.guard.test.ts` and the `admin-surface.ratchet.test.ts`
- `pnpm build` for the console
- No new env var is *required* to boot: every addition has a default

## Out of scope

- `packages/platform-auth/src/csrf.ts` also reads `x-forwarded-host` into its
  allowed-hostname set. That is a different shape of bug — it makes the CSRF
  check permissive rather than producing an attacker-controlled URL — and
  tightening it risks breaking writes across both apps. Note it in the summary
  for a follow-up issue; do not change it here.
