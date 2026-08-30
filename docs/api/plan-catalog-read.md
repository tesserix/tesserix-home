# The plan catalog read endpoint

`GET /api/v1/plan-catalog?mode=<test|live>` on `tesserix-home`'s console
(`apps/console/app/api/v1/plan-catalog/route.ts`). This is the contract a
product consumes to price itself — today that consumer is mark8ly, which
currently compiles its Stripe prices into
`internal/billing/pricing/catalog.go` and is meant to stop doing that once it
reads this endpoint instead.

Read this before writing a client against it. Where this document and the
code disagree, the code is right — this file describes
`apps/console/app/api/v1/plan-catalog/route.ts` at commit `f58bfb8` on
`feat/plan-catalog-read-endpoint`, and it is a bug if it drifts from that
file.

---

## 1. The URL, and why `v1` is in it

```
GET https://<console-host>/api/v1/plan-catalog?mode=test
GET https://<console-host>/api/v1/plan-catalog?mode=live
```

`mode` is required and has no default. It must be exactly `test` or `live`
(`StripeMode` in `apps/console/lib/billing/stripe-read.ts`) — anything else,
including an absent parameter, is refused before any database read happens
(see §5).

The version segment is not decoration. This response shape is a contract
between two repositories, not an internal view the console is free to reshape
whenever it likes. **Additive changes are the only safe ones** — adding a
field to an object is fine, because a consumer that doesn't know about a new
field simply ignores it. Renaming a field, removing one, or changing its type
or meaning is a breaking change, and it happens behind `/api/v2/plan-catalog`,
never as a silent edit to this route. If you're implementing a client, treat
every field documented in §3 as pinned, and treat any field this document
doesn't mention as something you must not depend on existing tomorrow.

---

## 2. Auth: a Zitadel machine identity, and how it gets checked

The caller is a Zitadel **service user** (a machine identity), not a human
operator. It presents a bearer token:

```
Authorization: Bearer <zitadel-access-token>
```

Verification happens in two genuinely separate steps, and the two failure
modes below exist specifically so a misconfigured caller can tell which one
it hit.

**Step 1 — is this a real, current token at all?**
`verifyMachineAuthHeader` (`packages/platform-auth/src/zitadel.ts`) verifies
the token's signature against Zitadel's JWKS, and checks issuer, audience,
subject, and that the token's organization matches the configured internal
org (when one is configured). A missing header, a malformed header, a bad
signature, a wrong issuer, a wrong audience, an expired token, or a token
from the wrong organization all fail this step identically. There is no
partial credit: a caller with no token and a caller with an expired one get
the same answer, because neither can act on a finer-grained answer than "you
are not authenticated" — see §5 for the status code this produces.

**Step 2 — does this (now-verified) identity hold the right role?**
`assertCapability(identity.roles, "read-plan-catalog")`
(`packages/platform-auth/src/capabilities.ts`). `read-plan-catalog` is a
capability that exists specifically for this: it grants reading the
*published* catalog and nothing else — not `billing`'s wallets, refunds,
payouts or subscription state, and not `publish-catalog`'s ability to write
prices. A machine built to read prices holds only this string. It is
independent of every other capability in the system; nothing implies it and
it implies nothing else.

**How a product actually obtains a token.** This is a Zitadel service user
(machine-to-machine OAuth2 client-credentials flow) on the same identity
platform the console's own operators authenticate against
(`auth.tesserix.app`). Concretely, standing this up requires, on the Zitadel
side: a service user provisioned for the consuming product, granted the
`read-plan-catalog` role on the Platform Console project, which it presents
in access tokens as the project-scoped
`urn:zitadel:iam:org:project:{projectId}:roles` claim — NOT the flat
`urn:zitadel:iam:org:project:roles`, which a real service-user token was
confirmed not to carry at all (#433). The
consumer then runs the standard OAuth2 client-credentials grant against
Zitadel's token endpoint to mint an access token before each call (or caches
one until it expires). The exact audience value the token must carry is not
fixed by this document — see the deployment precondition below, because it
is not yet a value anyone can hand you.

**Deployment precondition on the console side —
`ZITADEL_MACHINE_AUDIENCE`.** `getZitadelMachineConfig()` in
`packages/platform-auth/src/zitadel.ts` reads this environment variable and
throws if it is unset; there is no fallback and no default. Its value is
whatever `aud` Zitadel actually puts on an access token issued to the
specific service user that calls this route — it is **not**
`ZITADEL_CLIENT_ID`'s value, which belongs to a different application (the
console's own operator OIDC client) and would silently accept the wrong kind
of token if reused here. This value can only be read off a real token issued
by the live Zitadel instance for the calling service user; nobody should
guess it or copy it from another variable. Until this variable is set with
the correct value in the console's deployment, every call to this endpoint
fails with 401 regardless of how correct the caller's token is — this is a
precondition on the console's deployment, not on the consumer's client code,
but it will look to the consumer exactly like their own auth is broken.
Confirm with whoever runs the console that this variable is set to the
correct audience before assuming a client-side bug.

**Path exemption, so you know why this route isn't behind the console's
login redirect.** `apps/console/middleware.ts` gates almost every route
behind an operator session (cookie or bearer session token). `/api/v1/plan-catalog`
is listed verbatim in `MACHINE_AUTH_PATHS` and is matched by exact string
equality, not by prefix — a deliberate choice so that a future path filed
under `/api/v1/plan-catalog/...` does not silently inherit the same
exemption; each sub-resource has to opt in explicitly. Both the bare path
and its trailing-slash form are listed, because Next preserves a trailing
slash in `nextUrl.pathname` when middleware runs: without the second entry,
a client whose HTTP library appends one would get a flat `401` from
middleware no matter how correctly it authenticated, with nothing in the
response to point at the cause. Prefix matching would have covered that case
too, and would also have admitted `/api/v1/plan-catalog/..%2fadmin`; two
literals cover the real client and admit nothing else. A request to this
exact path skips the operator-session check entirely and goes straight into
the route handler, which then does its own, separate machine-token
verification as described above. This route is unauthenticated by
middleware and authenticated by itself.

---

## 3. The response shape, field by field

A `200` body looks like this:

```json
{
  "mode": "test",
  "revision_id": "rev-42",
  "published_at": "2026-08-20T00:00:00.000Z",
  "prices": [
    {
      "lookup_key": "mark8ly_starter_monthly_usd_v1",
      "plan": "starter",
      "period": "monthly",
      "tier": "standard",
      "currency": "usd",
      "unit_amount_minor": 1900,
      "tax_behavior": "unspecified"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `mode` | `"test" \| "live"` | Echoes the `mode` query parameter you asked for. Never inferred, never defaulted. |
| `revision_id` | `string` | The catalog's version. This **is** the version identifier for the whole payload — see §6, it is also the ETag value verbatim. |
| `published_at` | `string` | ISO 8601, UTC, of when this revision was published. |
| `prices` | array of price objects | One entry per active price in this mode. Never `null`; an unpublished mode is a `404`, not a `200` with an empty array — see §4. |
| `prices[].lookup_key` | `string` | Stable identifier for the price, matching what was used to create it in Stripe. |
| `prices[].plan` | `string` | Plan name (e.g. `starter`). |
| `prices[].period` | `string` | Billing period (e.g. `monthly`). |
| `prices[].tier` | `string` | Pricing tier (e.g. `standard`). |
| `prices[].currency` | `string` | ISO currency code, lowercase (e.g. `usd`), matching Stripe's own convention. |
| `prices[].unit_amount_minor` | `number` | **Minor units.** `1900` for a $19.00 price. Say this out loud before writing the multiplication in your client: this is cents (or the equivalent smallest unit for the currency), not dollars. A consumer that treats this field as major units and charges `unit_amount_minor` dollars instead of cents mis-prices by 100x. This mirrors the estate's own money convention (`PLATFORM-API-CONVENTIONS.md` §4.2) rather than inventing a new one for this endpoint. |
| `prices[].tax_behavior` | `string` | Stripe's tax-behavior setting for the price (e.g. `unspecified`, `inclusive`, `exclusive`). |

**A field that is deliberately absent: `published_by`.** The console's own
internal catalog view can name the operator who published a given revision;
this response never does. `published_by` names an individual, and this
payload crosses a repository boundary into a product's runtime pricing
path — an operator's identity has no legitimate reason to leave this
database and travel into mark8ly's checkout flow. If you need to know who
published a revision, that's a question for the console's own UI, not for
this endpoint, and it will not become one later without a version bump.

Every field above is present in every `200` and every `304` (the `304` has
no body at all — see §6). There is no partial or degraded shape: the route's
error handling is built so that a database failure never produces a body
that has some price fields and not others (see §5's `5xx` case).

---

## 4. 404 means "never published" — read this paragraph twice

**A `404` from this endpoint means the requested `mode` has never been
published. It does not mean the catalog is empty, and it must never be
treated as equivalent to a `200` with `prices: []`.** This is the single
most consequential fact in this document, because of what a client does with
each answer.

If mark8ly (or any consumer) caches a `200` with an empty `prices` array,
that cached "the catalog is empty" answer is a plausible-looking state — a
naive client would serve it, and would then be unable to price anything at
all, silently, for as long as the cache lives. A `404` cannot be mistaken
for a legitimate priced state the way an empty array can, and that is
exactly why the route is built to distinguish them: `readLivePublication(mode)`
returning `null` is answered with a `404` and a body of
`{"error": "not_published", "message": "mode \"<mode>\" has never been published"}`,
never a `200`.

Practically: your client should treat `404` as "this mode has no catalog
yet — do not cache this as an empty result, and do not treat it as a signal
to clear whatever catalog you already have." Combined with the fail-open
posture in §7, the correct behavior on `404` for a mode you have previously
successfully fetched is almost certainly to keep serving your last known
good catalog for that mode, exactly as you would on a `5xx` or a timeout.

---

## 5. Every status code

| Status | Meaning | Body |
|---|---|---|
| `200` | Success. The published catalog for the requested mode. | Full shape from §3. |
| `304` | The `If-None-Match` header you sent matches the current `revision_id`. | Empty. `ETag` and `Cache-Control` headers are still present. |
| `400` | `mode` was absent or was not `test`/`live`. | `{"error": "invalid_mode", "message": "mode must be one of: test, live"}` |
| `401` | The request did not carry a valid, verified Zitadel machine token. Covers: no `Authorization` header, a malformed one, a bad signature, wrong issuer, wrong audience, an expired token, or a token from outside the configured internal org. | `{"error": "unauthorized"}` |
| `403` | The token verified — the caller *is* who it claims to be — but its roles do not include `read-plan-catalog`. | `{"error": "forbidden"}` |
| `404` | `mode` is valid but has never been published. **Not** an empty catalog — see §4. | `{"error": "not_published", "message": "..."}` |
| `500` | Something failed reading the database (connection failure, missing table, etc.), after auth and mode validation passed. | `{"error": "unavailable"}` — no partial catalog data, no driver error message. |
| `501` | The console's database is not configured in this environment at all. | `{"error": "not_configured"}` |

**401 vs. 403, and why your client needs to tell them apart.** These are
never collapsed into a single "denied" outcome, because they name two
different repairs:

- **401** means your credential itself is the problem — you have no token,
  an expired one, or one that doesn't verify against this issuer/audience.
  The fix is on the auth side: reissue or refresh the token, check
  `ZITADEL_MACHINE_AUDIENCE` is actually set correctly on the console (see
  §2), check your client is sending `Authorization: Bearer <token>` at all.
- **403** means your credential is fine — Zitadel issued it, it verified
  successfully, the console knows exactly who you are — but the service
  user backing it has not been granted the `read-plan-catalog` role on the
  Platform Console project. The fix is a role grant in Zitadel, not a code
  change or a token refresh.

A client that logs these identically (or a human debugging one that does)
will chase the wrong fix: retrying a token refresh forever against a 403 is
wasted effort, and asking someone to grant a role in response to a 401 is
wasted effort in the other direction. Log the status code distinctly and
alert on them distinctly.

The `400`/`401` ordering is also pinned, not incidental: authentication is
checked *before* mode validation, so a request that is both unauthenticated
and carries a bad `mode` value gets `401`, never `400`. An unauthenticated
caller should never learn what values `mode` accepts before it has proven
who it is.

---

## 6. Caching: `no-cache`, and the ETag *is* the revision

Every `200` and `304` carries:

```
Cache-Control: no-cache
ETag: "rev-42"
```

`no-cache` does not mean "don't cache" — it means a compliant cache (or your
own client-side cache) **must revalidate** before serving a stored response,
rather than serving it for some TTL without asking. `max-age` was
considered and rejected for this endpoint: it would let a consumer serve a
superseded price for up to the TTL's duration with no way for the console to
shorten that window after a publish, and a stale price actually charged is a
wrong price actually charged.

Revalidation is cheap, though: send the ETag you last saw back as
`If-None-Match`, and a still-current revision costs you one round trip with
no body:

```
GET /api/v1/plan-catalog?mode=live
Authorization: Bearer <token>
If-None-Match: "rev-42"

→ 304 Not Modified   (Cache-Control and ETag headers still present, no body)
```

Anything else — a stale revision, no `If-None-Match` at all — gets the full
`200` body. The route accepts a comma-separated list of entity tags and the
weak-comparison `W/` prefix in `If-None-Match`, per RFC 9110, so a
standards-conforming HTTP cache in front of your client will interoperate
correctly without special-casing this endpoint.

**The important structural point: `revision_id` *is* the version, not a
cache-busting incidental.** It is the exact same string sent both in the
JSON body and as the ETag (quoted, per RFC 9110 §8.8.3 — send it back quoted
in `If-None-Match`). Practically, this means your client should not be
picking a TTL and guessing when to refetch. Store `revision_id` alongside
whatever catalog you cache, and revalidate against it — a change in
`revision_id` is the signal that the catalog changed, and its absence of
change is the signal that nothing did, cache lifetime aside entirely.

---

## 7. The obligation this places on the consumer: fail open, never load-bearing

This endpoint must never become a runtime dependency on the critical path of
checkout or subscription flows. Concretely: **do not call this endpoint
synchronously inside a request that is trying to complete a purchase.**
Fetch and cache the catalog out of band (on a schedule, on startup, or
revalidated opportunistically per §6), and serve checkout and subscription
flows from that cache.

If this endpoint is down, slow, timing out, or returning `5xx`, the correct
behavior for a consumer is to **fail open**: keep serving the last known
good catalog you have cached, and let the checkout proceed against those
prices. A checkout that fails because the console's plan-catalog endpoint
happened to be unreachable at that moment is a worse outcome than a checkout
that completes against a catalog that is a few minutes (or longer) stale.
This console is not part of mark8ly's (or any consumer's) uptime budget for
revenue-critical flows, and it must not be allowed to become part of it by
accident through a synchronous dependency.

This is also why §4's distinction matters operationally, not just
semantically: a `404` and a `5xx` should both be treated the same way by a
consumer that already has a cached catalog for that mode — as "I couldn't
get a fresher answer this time," not as "the catalog is now empty" or "stop
serving prices." The only two states that should ever cause a consumer to
stop pricing something are (a) it has never successfully fetched a catalog
for that mode at all, or (b) an operator has told it directly to stop —
never a transient failure of this endpoint.
