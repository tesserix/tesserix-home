---
id: 260826-h34
slug: federation-hmac-signing
date: 2026-08-26
issue: tesserix-home#334
---

# Sign federation requests with mark8ly's HMAC scheme

`platform-api/internal/platform/federation/client.go:91-93` sends a bare
shared secret plus two operator headers. Mark8ly's
`platformadmin.RequirePlatformAuth` requires an HMAC-signed request with a
timestamp window and single-use nonce. Every federated call 401s today, so
the estate audit cutover merged in #322 cannot be flipped on.

Mark8ly's implementation is the reference and it is right; ours changes.
Reference: `mark8ly services/marketplace-api/internal/handlers/platformadmin/
signature.go`, verified against the checkout at origin/main today.

## The scheme

Eight fields joined by `\n`, HMAC-SHA256, lowercase hex:

    METHOD (uppercased, trimmed)
    Path              <- decoded URL.Path, NEVER RawPath/EscapedPath
    CanonicalQuery    <- keys sorted, values within a key sorted, QueryEscape
    hex(sha256(Body))
    Timestamp         <- unsigned decimal Unix seconds, no leading + or -
    Nonce
    Operator
    Capability

Headers: `X-Platform-Operator`, `X-Platform-Capability`,
`X-Platform-Timestamp`, `X-Platform-Nonce`, `X-Platform-Signature`.

Server window is `defaultWindow = 5 * time.Minute` (middleware.go), and the
nonce TTL is anchored to the signed timestamp, so a stale clock on our side
is a hard failure, not a slow one.

## Tasks

1. **Port the golden vectors first (RED).** Copy mark8ly's four vectors into
   `federation/testdata/vectors.json` verbatim and write
   `signature_test.go` asserting both the canonical string and the signature
   for each. Fails to compile before task 2 — that is the point.
2. **`signature.go`.** `SignatureInput`, `CanonicalQuery`, `CanonicalString`,
   `Sign`. Mirrors the reference; no `Verify` (we only sign). Rejects `\n`/
   `\r` in the six joined fields and rejects an empty secret.
3. **Nonce + clock.** `crypto/rand` hex nonce; `now`/`nonce` funcs injectable
   on `Client` so the vectors and the client test are deterministic. No new
   module dependency — everything is stdlib.
4. **`client.go`.** Build the request first, then sign from `req.URL.Path` and
   `req.URL.RawQuery` so net/url does the decoding the scheme requires.
   Replace the three old headers with the five signed ones. Operator still
   comes from the verified session; nothing client-supplied is signed.
5. **`registry.go` note.** `FEDERATION_<SLUG>_BASE_URL` must end in
   `/api/v1/platform` — an Istio AuthorizationPolicy in `istio-ingress`
   denies un-JWT'd requests to `/api/v1/admin/*`, so the wrong base returns
   403 at the mesh, invisibly to CI and local dev.
6. Update `client_test.go` — its current assertions pin the headers being
   removed.

## Acceptance

- [ ] All four golden vectors pass on canonical string AND signature
- [ ] `go test ./...` green in platform-api
- [ ] No `X-Internal-Auth` / `X-Operator-*` left in the federation client
- [ ] Empty secret rejected rather than signing
- [ ] `/api/v1/platform` base-URL note recorded beside BASE_URL

## Not in scope

Response contract (verified unchanged in #334), the `PLATFORM_API_ORIGIN`
flip itself, and any deploy-time secret provisioning.
