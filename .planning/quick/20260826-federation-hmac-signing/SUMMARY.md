---
id: 260826-h34
slug: federation-hmac-signing
date: 2026-08-26
issue: 334
status: complete
---

# Sign federation requests with mark8ly's HMAC scheme

Closes #334.

## What changed

### `platform-api/internal/platform/federation/signature.go` (new)

The caller's half of mark8ly's request-signing scheme: `SignatureInput`,
`CanonicalQuery`, `CanonicalString`, `Sign`. It is a deliberate mirror of
mark8ly's `platformadmin/signature.go`, which their package doc names as the
only specification of the scheme.

`Verify` is not implemented. Nothing signs requests *to* the platform API this
way, and an unused constant-time comparison in a security-relevant file is
worse than an absent one.

### `platform-api/internal/platform/federation/testdata/vectors.json` (new)

A byte-for-byte copy of mark8ly's `testdata/vectors.json` — verified equal by
sha256 against their `origin/main` at time of writing. Copied rather than
re-derived: a fixture generated from our own canonicaliser would agree with
itself and prove nothing.

### `client.go`

`X-Internal-Auth` / `X-Operator-Id` / `X-Operator-Capability` are gone,
replaced by the five signed `X-Platform-*` headers. The new `sign` method takes
the *built* `*http.Request` rather than the caller's path string, so the path
it signs is the percent-decoded `req.URL.Path` net/url produced — the trap that
401s every encoded path with no local symptom.

Nonce is 128 bits of `crypto/rand` hex, fresh per call, because the far end
claims each one single-use. Timestamp is unsigned decimal seconds; their parser
rejects a leading `+` or `-` outright.

New `ErrSigning` sentinel, so a signing failure is distinguishable from a
malformed BaseURL. `sanitize` gives it its own closed-set string — "request
could not be signed" — rather than folding it into "product misconfigured",
which would send an operator to check the wrong thing.

### `registry.go`

Records that `FEDERATION_<SLUG>_BASE_URL` must end in `/api/v1/platform`. An
Istio AuthorizationPolicy in `istio-ingress` denies un-JWT'd requests to
`/api/v1/admin/*`; this surface authenticates by HMAC, so the wrong prefix
returns 403 at the mesh, before the application, invisibly to local dev and CI
because Istio is in neither.

Also corrects the empty-secret comment, which described the old behaviour
(sending `X-Internal-Auth: ""`).

### Test fixtures across the audit module

Every `federation.Product` literal in tests gained a secret. `Sign` now refuses
an empty one, so a fixture without a secret fails at signing rather than
reaching its test server — one of them hung the handler package for the full
timeout rather than failing.

## Verification

- All four golden vectors pass on canonical string **and** signature.
- `TestGetReproducesAGoldenVectorEndToEnd` drives `Client.Get` with a pinned
  clock and nonce and asserts the published signature — proving the client
  feeds the canonicaliser the right things, which the canonicaliser's own
  tests cannot.
- Three mutations were run to confirm the suite has teeth, each caught by a
  different test: signing `EscapedPath()` instead of `Path`, a constant nonce,
  and a dropped capability header.
- `gofmt`, `go vet`, `go test ./...` all clean in `platform-api`.

## Not done

The `PLATFORM_API_ORIGIN` flip itself, and provisioning
`FEDERATION_MARK8LY_SECRET` in the cluster — the secret has to match what
mark8ly holds, which is a deploy-time coordination, not a code change.
