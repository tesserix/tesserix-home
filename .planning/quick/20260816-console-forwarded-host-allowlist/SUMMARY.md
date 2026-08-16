---
id: 260816-tmf
slug: console-forwarded-host-allowlist
date: 2026-08-16
issue: 184
status: complete
---

# Stop trusting client-supplied `X-Forwarded-Host` when building redirects

Closes #184.

## What changed

### `apps/console/lib/public-origin.ts` (rewritten, same signature)

The helper keeps its shape and its reason for existing; it stops believing an
arbitrary header. Order of decision:

1. Configured origin = `CONSOLE_PUBLIC_ORIGIN` (default
   `https://console.tesserix.app`), read **per call** so a pod restart or a test
   sees the current value. Parsed to prove it is a URL but returned as the
   configured string -- `new URL(x).origin` would silently rewrite the value we
   hand the browser. A malformed value falls back to the default rather than
   emptying the allowlist.
2. Claimed host = first value of `X-Forwarded-Host`, else `Host`, trimmed and
   lowercased. Only the first entry in a proxy chain is client-facing.
3. Claimed host **equals** the configured origin's host -> return the configured
   origin string **verbatim**. This is what drops the `X-Forwarded-Proto` trust:
   proto is never read on the production path, so a forged `http` cannot produce
   a downgraded URL.
4. Claimed host is in `CONSOLE_ALLOWED_HOSTS` (optional, comma separated) ->
   return `https://<host>`. An alternate hostname has to come back as itself or
   listing it would be pointless; the scheme is still not the client's to pick.
5. Non-production **and** loopback (`localhost`, `127.0.0.1`, `[::1]`, any port)
   -> return that host with the proto from `nextUrl.origin`, so dev stays on
   `http`. This is the one loophole in the allowlist and it does not exist in
   production.
6. Anything else -> configured origin. A rejected host is not an error; failing
   the request would turn a header nobody legitimately sends into a DoS knob.

No `*.tesserix.app` wildcard, per the plan.

Exact-string comparison, not `startsWith`/`endsWith`/`includes`, so
`console.tesserix.app.evil.com` and `parked.tesserix.app` both fail.

`request.nextUrl.origin` is still referenced only inside this file, so
`redirect-origin.guard.test.ts` stays green unchanged.

### `apps/web/app/auth/callback/route.ts` (private copy, same narrowing)

Same rule against `NEXT_PUBLIC_SITE_URL` (default `https://tesserix.app`). No
extra-hosts variable -- the plan did not ask for one and apps/web serves one
host.

### Callers

Untouched. `middleware.ts:56,76`, `app/auth/callback/route.ts:121` and
`app/auth/logout/route.ts:57` all call `publicOrigin(request)` and get a safe
value now without knowing anything changed.

## Test evidence

`apps/console/lib/public-origin.test.ts` -- 5 existing cases unchanged and still
passing, 13 added (18 total). New cases: forged host falls back; forged host
laundered through a proxy chain rejected; `X-Forwarded-Proto: http` on an
allowed host still yields https; case-insensitive match; prefix-extension
(`console.tesserix.app.evil.com`) rejected; suffix/subdomain
(`parked.tesserix.app`) rejected; `CONSOLE_ALLOWED_HOSTS` host accepted as
itself over https; loopback accepted in dev for all three spellings; loopback
**rejected** under `NODE_ENV=production`; no host header in production yields
the configured origin; malformed `CONSOLE_PUBLIC_ORIGIN` survives.

Plus a "guards the guard" case: moving `CONSOLE_PUBLIC_ORIGIN` to
`https://console.example.test` must flip **both** verdicts -- the new host
accepted, `console.tesserix.app` rejected. Without it a hard-coded literal
allowlist would pass every other assertion while checking nothing.

```
$ pnpm test          # turbo, repo root
 Tasks:    8 successful, 8 total
console:test:unit:  Test Files  36 passed (36)
console:test:unit:       Tests  372 passed (372)
```

```
$ cd apps/web && pnpm test:unit
 Test Files  20 passed (20)
      Tests  197 passed (197)
```

```
$ cd apps/console && pnpm build
 ✓ Compiled successfully in 3.9s
   Running TypeScript ...
   Finished TypeScript in 6.9s ...
 ✓ Generating static pages using 13 workers (7/7)
```

`pnpm lint` clean in both apps; `pnpm typecheck` clean in apps/web.

Both `redirect-origin.guard.test.ts` (2 tests) and
`apps/web/lib/admin-surface.ratchet.test.ts` are inside those runs and pass.

## Did apps/web get a test?

Yes -- `apps/web/app/auth/callback/route.test.ts`, 10 cases. The helper there is
module-private, but there is a genuine reachable seam that needed no
restructuring: Google redirects back with `?error=access_denied` when a user
cancels consent, and that branch builds its `/login` redirect from
`publicOrigin` and returns before any cookie check, token exchange or network
call. The test drives the exported `GET` with a `NextRequest` whose URL is the
pod's `https://0.0.0.0:3000` bind address and asserts on the `Location` header --
so it exercises the redirect a browser actually receives, not an export invented
for the test. It carries the same "guards the guard" pair (move
`NEXT_PUBLIC_SITE_URL`, both verdicts must move) and one case asserting the full
`https://tesserix.app/login?error=access_denied` location, which proves the
suite is on the cancelled-consent path rather than some generic fallback.

## Env vars

| Variable | Default | Required to boot? |
| --- | --- | --- |
| `CONSOLE_PUBLIC_ORIGIN` | `https://console.tesserix.app` | No -- pre-existing, already read by `lib/platform-api.ts:175`, reused rather than adding a second origin variable |
| `CONSOLE_ALLOWED_HOSTS` | `""` (empty) | No -- new, optional, comma-separated extra hostnames for preview/alternate hosts |
| `NEXT_PUBLIC_SITE_URL` | `https://tesserix.app` | No -- pre-existing |

Nothing new is required. Both apps boot and redirect correctly with zero
configuration.

## Deviations from the plan

**1. `apps/web`'s configured origin ignores a loopback value in production.**

`apps/web/next.config.ts:116` inlines `NEXT_PUBLIC_SITE_URL` at build time with
a `http://localhost:3002` default, and nothing in this repo's deploy config sets
it -- so a production build can genuinely carry `http://localhost:3002`. Applying
the plan's allowlist literally against that value would have rejected the real
`tesserix.app` host and redirected live users to their own machine: a working
login broken in exchange for closing a latent hole. So `siteOrigin()` treats a
loopback value as "unconfigured" when `NODE_ENV === "production"` and uses
`https://tesserix.app`. Covered by a test. In dev the value is honoured, and the
loopback exemption handles it anyway.

This is worth a separate look: `NEXT_PUBLIC_SITE_URL` being unset in the deploy
is a latent wrongness of its own (`lib/waitlist/announce.ts:31` reads it too,
where it only survives because it has the same string default).

**2. Both helpers use the configured origin, not `nextUrl.origin`, when no host
header arrives in production.** The plan did not specify this case. In dev
`nextUrl.origin` is right (and the existing test asserting it still passes); in
production it is the pod's bind address, which is the original 0.0.0.0 bug.

**3. Environment.** The checkout's `node_modules` was stale -- workspace packages
(`@tesserix/tsconfig`, `@tesserix/console-core`, `@tesserix/platform-auth`) were
not linked and `console-core` had no `dist`, so vitest failed to resolve them
before any of this work. Fixed with `pnpm install` and
`pnpm --filter @tesserix/console-core build` / `--filter @tesserix/platform-auth build`.
Pre-existing, unrelated to this change, no files committed for it.

## Out of scope -- follow-up

`packages/platform-auth/src/csrf.ts` also reads `x-forwarded-host` into its
allowed-hostname set. Different shape of bug: it makes the CSRF check
**permissive** (an attacker-chosen host joins the set of origins accepted for a
write) rather than producing an attacker-controlled URL. Tightening it risks
breaking writes across both apps -- including the console's server-to-server
calls, which name themselves via `CONSOLE_PUBLIC_ORIGIN`. Not touched here.
Should become its own issue.

## Commits

| SHA | Message |
| --- | --- |
| `aad1ff5` | `fix(console): validate X-Forwarded-Host against an allowlist before building redirects (#184)` |
| `4b05b08` | `fix(web): validate X-Forwarded-Host in the auth callback before building redirects (#184)` |

Not pushed; no PR opened.
