# The secrets cutover: Zitadel, capabilities, and the end of apps/web

**Date:** 2026-09-01
**Issue:** tesserix-home#274 (M4-2)
**Predecessor:** `2026-08-31-console-secrets-absorption-design.md` — the *product*
design (what the surface does). This is the *cutover* design (how it gets there).
It does not restate §5–§8 of that document; it makes them deployable.

---

## 1. Why this is one release and not four

The original plan had four remaining stages: auth swap, console UI, notifications,
retirement. They are not separable, and the reason is a single fact:

**`secrets-api` can serve a session cookie or a bearer token, and its two clients
each accept only one of them.** `secret-service`'s `apps/web` has a cookie and no
Zitadel session. The console has a Zitadel token and cannot hold a second
service's cookie. So the moment the API stops issuing cookies, `apps/web` is
dead — and the console surface has to already exist, or there is no UI at all.

The alternatives were to run both auth paths for a release, or to keep the cookie
and swap only the identity provider behind it. Both were rejected: they mean
building a session layer that is already scheduled for deletion, on the one
service in the estate whose job is guarding secrets, where two auth paths is
exactly one too many.

So: one design, one deploy moment, six merges. §9 covers the sequencing.

**What makes this affordable** is that the service is idle. In the 2.5 hours
after the pods restarted on 2026-08-31 the access log contained `/healthz` and
`/readyz` and nothing else — no user traffic, no machine traffic. A cutover with
no live sessions to preserve is a different risk than it appears on paper.

---

## 2. The shape change

`secrets-api` today is a browser application. It owns a full OIDC login
(`internal/auth/{oidc,pkce,loginstate}.go`), issues a sealed session cookie
(`session.go`, `middleware/session.go`), enforces CSRF on mutations, and runs
CORS with credentials for `apps/web`'s origin. Authorisation is
`internal/auth/allowlist.go`, whose own comment states the model: *"There are no
roles below it: an address is either a full administrator of the secret store or
it has no access at all."*

`platform-api` is the opposite. No login, no cookie, no CSRF. `Authenticate`
verifies a Zitadel bearer token against JWKS; `RequireCapability` gates each
route. The console owns the login and holds per-operator tokens.

`secrets-api` becomes the second shape.

### Deleted

| what | why it goes |
|---|---|
| `internal/auth/{oidc,pkce,loginstate,session,allowlist}.go` | the login flow moves to the console |
| `internal/api/handlers/auth.go`, `/api/auth/{login,callback,logout}` | ditto |
| `internal/api/middleware/session.go` | no cookie |
| `internal/api/middleware/csrf.go` | see below |
| `AllowCredentials` and `AllowedOrigins` in the CORS block | no browser talks to this service |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS` | replaced by Zitadel role grants |
| `adminEmails` in `charts/apps/secret-service/values.yaml` | ditto |

**CSRF goes with the cookie, and that is not an oversight.** CSRF defends an
*ambient* credential — one the browser attaches to cross-site requests
automatically. A bearer token attached explicitly by server-side console code is
not ambient and cannot be forged cross-site. Removing CSRF while keeping the
cookie would be a hole; removing both together closes the class. The one thing
that must not happen is removing CSRF first and the cookie later, so they are in
the same commit.

The chart's `adminEmails` comment currently reads *"The only humans who may sign
in. Everything else about this chart is infrastructure; this line is the actual
access-control decision."* After this, that sentence is false: the decision moves
into Zitadel, and the chart holds no access control at all. Leaving a stale
comment claiming otherwise is worse than leaving the field.

### Added

One `Authenticate` middleware and `RequireCapability` per route group. Nothing
else. `secrets-api` gains no database, no session store, and no new dependency
beyond the shared module in §3.

---

## 3. The shared auth module

`secrets-api` cannot import `platform-api/internal/platform/auth`: they are
separate modules (`github.com/tesserix/tesserix-home/{platform-api,secrets-api}`)
and Go's `internal/` rule forbids it across module roots. A workspace does not
change this.

`capabilities_contract_test.go` already argues the case against the obvious
workaround:

> The vocabulary exists in three places: Zitadel's project roles,
> `packages/platform-auth/src/capabilities.ts`, and `capabilities.go`. […] It
> reads the TypeScript source directly. That is deliberate: a hand-copied list
> here would be a fourth copy, and the thing most likely to drift is exactly the
> copy nobody is looking at.

A mirrored vocabulary in `secrets-api` would be that fourth copy. So:

**A new module `platform-auth/`, beside `platform-api/` and `secrets-api/`,**
holds the capability vocabulary, the `Verifier`, `Principal`, and the
`Authenticate` / `RequireCapability` middleware. It is nearly self-contained
already: stdlib, `github.com/coreos/go-oidc/v3`, and one internal helper
(`internal/platform/reqid`), which moves with it.

**`platform-api/internal/platform/auth` becomes an alias layer.** Go type aliases
and const re-exports:

```go
type Capability = authcore.Capability
const CapPlatform = authcore.CapPlatform
```

so all **65** files in `platform-api` that import `platform/auth` compile
unchanged. This is the whole reason for the alias layer: a 65-file import rewrite
in an actively developed service is a large diff to review for no behavioural
gain, and it would collide with whatever else is in flight.

`capabilities_contract_test.go` moves with the package and keeps guarding
Go↔TypeScript. Because there is still exactly one Go definition, no fourth copy
appears and the test's premise survives intact.

### Build wiring

- `Dockerfile.secrets-api` widens its build context to copy `platform-auth/` and
  `go.work` (today it copies only `secrets-api/`).
- `.github/workflows/secrets-api.yml` adds `platform-auth/**` to its path filter.
  Without this, a change to the capability vocabulary would not rebuild the
  service that depends on it — the workflow would pass while shipping nothing.
- The same filter goes on `platform-api`'s workflow, for the same reason.

---

## 4. Authorisation

Two capabilities, both of which already exist. **No new Zitadel role is minted.**

- **`platform`** — entry. Its declared meaning already covers *"governance
  surfaces (audit log, outbox, GDPR queue, break-glass, settings)"*, which is
  what this is.
- **`rotate-credentials`** — the verb. Its declared meaning is authority over
  live credentials, which is exactly what writing a secret and approving a reader
  grant both are. The predecessor design already chose it for approval (§3).

### The rule: the gate follows effect, not HTTP verb

A route that changes live state needs the verb. A route that only opens a pull
request needs the surface. Reading needs the surface.

This is not the same as gating on the HTTP method, and the difference is not
cosmetic — it was found by reading the handlers rather than the route list.
`POST /api/access/grants` looks like a proposal and is not: `CreateGrant` calls
`bao.GrantAll` and grants the access **immediately**, then opens a pull request
to record what it already did. The PR is a receipt, not a gate. `Deny` and
`Allow` are the same shape. Meanwhile `POST /api/access/whitelist` genuinely only
proposes — `Rewire`'s comment says it outright: *"It grants nothing on its own."*

Gating by method would therefore have put an immediate OpenBao grant and a
no-op-until-merged proposal in the same tier.

### Route table

| routes | effect | gate |
|---|---|---|
| every `GET` — `/api/backends`, `/api/backends/status`, `/api/secrets`, `/api/secrets/*`, `/api/secret-versions/*`, `/api/access/grants`, `/api/access/denied`, `/api/cluster/*`, `/api/reviews`, `/api/reviews/:n` | none | `platform` |
| `PUT`/`DELETE /api/secrets/*`, `POST /api/secret-versions/*` | writes OpenBao / GSM now | `platform` + `rotate-credentials` |
| `POST`/`DELETE /api/access/grants`, `POST`/`DELETE /api/access/denied` | writes OpenBao policy now | `platform` + `rotate-credentials` |
| `POST /api/reviews/:n/{approve,merge,reject}` | merges to `tesserix-k8s` now | `platform` + `rotate-credentials` |
| `POST`/`DELETE /api/access/whitelist`, `POST /api/access/wiring` | opens a PR; nothing until merged | `platform` |
| `/healthz`, `/readyz` | none | public, explicitly |

**Writing or deleting a secret value requires the verb, not just the surface.**
Gating `PUT /api/secrets/*` on `platform` alone would let anyone who can read the
estate uptime board overwrite a production credential. `rotate-credentials` is
named for precisely this. The capability model's own stated bet is that *"the
risk verbs are what separate reading the uptime board from rotating a live
credential"* — this is that sentence applied.

### A known asymmetry this creates

A `platform`-only holder can propose a **whitelist** entry (the External Secrets
side, in `tesserix-k8s`) but cannot create an **OpenBao grant** at all, not even
as a proposal — because the only route that creates one also writes it live.

This is the right call for now: it fails closed, and the alternative is letting
the broad surface write OpenBao policy. But it narrows the predecessor's §3
model, which imagined a non-holder proposing any access change and waiting. The
clean fix is to split `CreateGrant` into a propose-only path and an immediate
path, gated separately. That is a change to the product design, not to this
cutover, and should be filed rather than absorbed here.

### Why entry is not the verb

Gating *entry* on `rotate-credentials` was considered and rejected: it collapses
the predecessor's §3 model. If the verb is needed to look, then everyone who can
see the tool can also auto-merge, the proposal queue is never used, and the
two-tier design silently degrades to one tier. Entry must be a surface for the
queue to mean anything.

### The resulting two tiers

| holder | can |
|---|---|
| `platform` | read the inventory; propose whitelist and wiring changes, which **queue** |
| `platform` + `rotate-credentials` | write and delete secret values; grant and deny OpenBao access; approve any proposal, and have their own **auto-merge** |

With two administrators today, both holding both, nothing changes in practice.
It begins to matter the moment a third person holds `platform`.

---

## 5. Identity and the audit trail

`Principal` carries `Subject` and `Capabilities`. **It carries no email**, because
a Zitadel operator *access* token has no `email` claim — the same fact behind
#450, where every human was recorded as a service by an email-presence heuristic.

So `audit.Event.Actor` becomes the Zitadel subject: a stable, opaque user id.
This is the correct thing to persist. An email is mutable and reassignable; an
audit record keyed on one is a record that can be made to mean something else.

The cost is that every audit line and every "proposed by / approved by" in the UI
is an opaque id until resolved. **The console resolves it at render time**, since
it holds the session that knows who the operator is. Two consequences must be
handled rather than discovered:

- **The GitHub pull request body** currently names a person by email. It is read
  by humans outside the console, where no resolution happens. The console must
  supply the display name when it proposes, or the PR body becomes unreadable.
- **`ConsoleClientID` must be configured** on `secrets-api`'s verifier, or every
  operator is recorded as `KindService`. `verify.go` is explicit that this is
  compared against an explicit config value and never inferred from claim shape.

**`Kind` is never authorised on.** `verify.go`: *"NEVER authorise on it.
Authorisation is by capability, and keeping these two apart is what stops a
change to caller CLASSIFICATION from silently becoming a change to caller
ACCESS."* It is used for the audit trail and nothing else.

`audit` remains a JSON-lines logger to stdout. No database is introduced.

---

## 6. How the console calls it

The console's existing path is reused unchanged: `lib/platform-api.ts`,
`getPlatformApiToken()`, `operator-token-store`, `PlatformApiError` — pointed at
a second base URL.

**The same operator token works.** `Verifier` checks `aud` against the Zitadel
**project id**, and `secrets-api` is in the same project as `platform-api`. So
there is no new OIDC client, no second token, no additional login, and nothing
added to the token store. A revoked capability behaves exactly as it already does
for every other console surface, including #285's five-minute revocation.

---

## 7. Networking and exposure

Once `apps/web` is gone the console is the only caller, so the service stops
being reachable from the internet.

- **Delete** the `VirtualService` and the `host` value. `secret-service.tesserix.app`
  stops resolving.
- **Narrow** the `AuthorizationPolicy` on `secret-service-api` from "any workload
  in `istio-ingress`, `istio-system`, `secret-service`, `monitoring`" to the
  console's service account principal — **keeping** the existing
  `cluster.local/ns/devai/sa/devai-api` rule (§8).
- **Delete** `secret-service-web` entirely: Deployment, Service,
  AuthorizationPolicy, PodDisruptionBudget, and its image values.

The policy's comment — *"ztunnel is L4-only — the OIDC session and email
allowlist are enforced by the API itself, not here"* — must be rewritten. After
this the L4 principal is a genuine second gate, not a note explaining that
authorisation happens elsewhere.

Debugging is by `kubectl port-forward`. The image is distroless, so there is no
shell in the pod either way.

---

## 8. The devai broker, deliberately unsolved

`charts/apps/devai-api/values-prod.yaml` declares:

```yaml
brokerUrl: "http://secret-service-api.secret-service.svc.cluster.local:8080"
brokerAudience: "secret-service"
brokerTokenFile: "/var/run/secrets/devai/secret-service/token"
```

— a projected Kubernetes ServiceAccount token at audience `secret-service`.
`secrets-api` has no broker endpoint and no code path that accepts a Kubernetes
SA token, and its access log shows no devai traffic. **The integration is
configured but not built.**

This design does not build it and does not preclude it. The Istio principal rule
and the `allow-ingress-devai-broker` NetworkPolicy are **kept**, because removing
them would silently foreclose the integration rather than decide against it.

One thing should be filed rather than left implied: **the estate has two
different answers for machine callers and this config picks the one with no
precedent.** `platform-auth`'s answer is a Zitadel *service user* holding a
capability — `KindService`, with `read-plan-catalog` as the worked example.
devai's chart is wired for a Kubernetes projected token, which nothing in
`platform-auth` verifies. Whoever builds the broker has to choose, and the chart
currently implies a choice nobody made.

---

## 9. Sequencing

**`platform-api` and `console` auto-deploy on merge** — both carry
`kargo.akuity.io/authorized-stage: kargo-tesserix-home:prod` and float on
`:latest`. **`secrets-api` does not**, because #470's follow-up pinned it to
`main-<sha>` with `pullPolicy: IfNotPresent`.

That asymmetry is the whole sequencing plan. Merging is publishing for two of the
three; the third can be merged and held.

| # | change | deploys? |
|---|---|---|
| 1 | `platform-auth/` module + alias layer in `platform-api` | **yes** — behaviour-neutral, and proves the alias layer in production before anything depends on it |
| 2 | `secrets-api`: bearer auth in, cookie/session/CSRF/allowlist/Google config out | **no** — the pinned tag holds it |
| 3 | Console secrets surface, behind an env flag so the nav entry is dark | yes, visibly nothing |
| 4 | Notifications (§8 of the predecessor) | **yes** — console-only for `access_proposal_open`. `access_proposal_merged` additionally requires the `requested-by:` trailer and `GET /api/reviews/merged` in secrets-api, which must deploy first — see the [merged-notification design](2026-09-02-access-proposal-merged-notification-design.md) |
| 5 | **The chart PR** — bump the tag, drop the VirtualService and host, narrow the AuthorizationPolicy, delete the web workload, delete `adminEmails` | **yes — this is the cutover.** Flip the console flag after it is verified |
| 6 | Retirement: delete `secret-service`'s `rollout restart` steps, then archive | n/a |

**Rollback is reverting step 5**, a single chart PR. This is what the pinned tag
bought, and it is why step 2 can be a large merge without being a large risk.

**Step 6 has an ordering trap.** `secret-service`'s `api-build.yml` and
`web-build.yml` both run `kubectl rollout restart` against these deployments.
Archiving the repo without deleting those steps first leaves a live path that can
restart a workload the repo no longer builds.

---

## 10. Tests

Per-route capability tests are table-driven and unremarkable. Three tests carry
the actual weight:

**Route completeness.** Enumerate the router's registered routes and assert every
one carries a gate, failing on any route not on an explicit public list. Per-route
tests prove the gates you remembered; this proves there are no others. The failure
mode it exists for is the route someone adds in six months and forgets to gate,
which no per-route test can catch. This encodes the predecessor's §4 requirement:
*"refuse by default, no fallback that silently allows."*

**`Store` has no `Read`.** §6 of the predecessor rests on *"The `Store` interface
has no `Read` method at all, so no handler can leak one."* That is an assertion
about an absence, and absences are what regress unnoticed. Same shape as the
write-blind role test in tesserix-k8s#781.

**The alias layer is not a fork.** A test asserting `platform-api`'s re-exported
constants are identical to `platform-auth`'s, so the alias file cannot drift into
a second definition — the failure the alias layer exists to prevent.

**Every test is mutated before it is trusted.** Change the gate, watch the test
fail, change it back. A test that has only ever passed has demonstrated nothing;
tesserix-k8s#781 records five such mutations and is the pattern to follow.

**Before the union lands (step 4),** the ticket path through `NotificationItem`
gets tests *first*. Tickets render through the type that is being changed, and a
bell regression in the same release as the secrets cutover would be hard to
bisect.

---

## 11. What this does not do

- **It does not build the devai broker** (§8).
- **It does not scope the GitHub credential.** #464 — the service acts through a
  named individual's personal PAT with admin on `tesserix-k8s`. The predecessor's
  §2 and §4 both note that a scoped machine identity is what would make the Git
  audit trail honest. True before this change and true after; not made worse by
  it.
- **It does not split `CreateGrant`.** The route both writes OpenBao and opens a
  recording PR, so it must take the verb, which means a `platform`-only holder
  cannot propose an OpenBao grant at all (§4). Splitting it into propose-only and
  immediate paths is a product-design change; file it.
- **It does not split the `platform` surface.** Every `platform` holder can now
  see every secret's name, metadata and reader list. `capabilities.ts` already
  names this surface as *"the one to split first"* if the governance and health
  halves ever want different people. This widening is deliberate and should be
  tracked, not rediscovered.
- **It does not pin `platform-api` or `console`.** Both remain on `:latest`;
  #468 is fixed only for `secret-service`.
