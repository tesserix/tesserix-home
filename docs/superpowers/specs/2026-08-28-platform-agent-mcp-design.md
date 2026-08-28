# The platform-agent MCP surface

How a platform-level AI agent authenticates to the estate's admin data, what it
may read, and what is recorded about it.

Status: **design, approved 2026-08-28. Not implemented.**
Origin: `tesserix/kora#511` (the blocking child of kora's "Platform agent MCP"
milestone, epic `kora#515`). That milestone is deprioritised; this document is
the decision it said was "worth thinking about early" because it "gets worse if
rushed later".

Companion to `2026-08-14-product-admin-integration-contract.md`, which defines
the HTTP surface this reads through. Where the two disagree, the contract wins.

## Contents

1. [What this is for](#1-what-this-is-for)
2. [Topology: one gateway, not N servers](#2-topology-one-gateway-not-n-servers)
3. [The principal](#3-the-principal)
4. [Authorization](#4-authorization)
5. [The tool set](#5-the-tool-set)
6. [Untrusted content](#6-untrusted-content)
7. [Protocol](#7-protocol)
8. [Failure semantics](#8-failure-semantics)
9. [Audit](#9-audit)
10. [Evidence](#10-evidence)
11. [Rejected alternatives](#11-rejected-alternatives)
12. [Open items](#12-open-items)

---

## 1. What this is for

A platform agent should be able to answer *what is waiting on a human, is the
estate healthy, and is its AI working* by calling the platform directly over
MCP, without product-specific glue inside any agent.

**Read-only.** Every write is out of scope, including the §8.3 inbox triage
actions products now declare. Revisiting that posture is a later decision with
its own evidence.

**This is distinct from a product's own agent surface.** `kora#380`'s governed
AI pilot serves a product's own reviewed agent on behalf of an authenticated
END USER, and re-authorizes that subject at the data boundary. Here there is no
end user. That mechanism does not transfer and its protections must be replaced
rather than assumed.

### Two callers, both real

| | operator-initiated | autonomous |
|---|---|---|
| trigger | a person asks in the console | schedule or event |
| acting for | an operator | **nobody** |
| watched | yes | no |
| credential at rest | no | **yes** |

Both exist. A model that cannot represent "acting for nobody" forces every
scheduled run to name a fictional operator — the placeholder failure this estate
legislates against elsewhere (a UUID header omitted rather than zeroed, an
absent `sublabel` kept distinct from `""`).

---

## 2. Topology: one gateway, not N servers

**The MCP server is a module in `platform-api`. Products implement nothing.**

```
agent ──MCP (Zitadel JWT)──▶ platform-api MCP module ──federation (HMAC)──▶ product
                             │
                             └── principal, capabilities, tool set, agent audit
```

### Why not a server per product

The tool surface is a 1:1 re-skin of federation: health, kpis, inbox, entities,
audit-logs, plus kora's ai-metrics. Not one datum is reachable that federation
does not already serve over an authenticated, nonce-protected,
operator-attributed, conformance-checked path.

Two paths to the same rows would also disagree about who owns authorization.
`kora/api/internal/platformauth/middleware.go` states the current rule plainly:

> The VALUE of the capability gates nothing. Kora does not own the privilege
> model: the console asserts what it is exercising, this surface records it and
> refuses its absence.

A per-product MCP server that gated on capability would reverse that, leaving
the estate with two answers to "who may see this row" — and **the looser one
wins by construction**, since a caller refused on one path can be handed the
same data through the other.

Centralising also means product #2 adopts this by appearing in
`FEDERATION_PRODUCTS`: no OIDC verifier, no issuer dependency, no second
privilege model, no new secret. And the issuer stays on exactly one critical
path during an identity migration rather than N.

### The cost, stated

Product-side audit records the **operator**, not the agent: federation's
canonical string has no agent channel. Day one, agent attribution lives in
platform-api's audit. Carrying it downstream means one versioned, additive
change to a scheme that already has golden vectors and a CI conformance
checker — against N products each growing an auth stack. Deferred deliberately.

---

## 3. The principal

**A Zitadel-issued JWT, audience-bound to this MCP server, using RFC 8693
delegation semantics.**

| kind | `sub` | `act` | meaning |
|---|---|---|---|
| delegated | the operator | `{sub: agent}` | agent acting for operator |
| autonomous | the agent | **absent** | agent acting as itself |

Autonomous agents are Zitadel machine users authenticating by client
credentials — the shape MCP's own auth extension defines for "background
services … without a user present".

### Delegation is an audit fact, never an authorization input

`platform-api/internal/platform/auth/verify.go` already carries this rule, and
it is the single most important constraint in this document:

> `Kind` is a HEURISTIC, for logging and audit only. Zitadel does not mark a
> client_credentials token distinctly, so this is inferred from the presence of
> an email claim. NEVER authorise on it: authorisation is by capability, which
> is attested by the issuer, whereas this is a guess about the shape of a claim.

An earlier draft of this design derived a principal *kind* from claim presence
and then authorized on it — a narrow ceiling for autonomous callers. That is the
mistake the comment forbids, and it produces a specific bug: a malformed `act`
silently downgrading to "autonomous" while `sub` still names a human, recording
that human as the direct actor for a call nobody made.

So: **`sub` and `act` answer who acted for whom, and gate nothing.**

### `act` parsing is fail-closed

- `act` present but not an object with a non-empty string `sub` → **401**.
  Never a downgrade to autonomous.
- Nested `act.act` → **401**, until delegation chains have a stated
  authorization rule. They are permitted by RFC 8693 and unhandled here.
- The principal is derived in exactly one place, in the verifier. Never from a
  header, a tool argument, or anything a caller supplies.

---

## 4. Authorization

**Capability, always** — from the existing vocabulary pinned by the
`capabilities.go` ↔ `capabilities.ts` contract test. No new vocabulary.

Effective authority for a delegated call is the **intersection** of the agent's
own grant and the operator's capabilities. Neither half may widen the other.

> **Open item (§12.1): where both role sets come from.** RFC 8693 yields one
> token with one roles claim. If it carries the operator's roles, the agent's
> ceiling does not bind; if the agent's, there is nothing to intersect. The
> intersection must be computed **at the issuer/exchange**, which refuses to
> mint a token whose roles exceed the agent's own grant, so the gateway verifies
> a single already-intersected set. This moves a trust boundary and must be
> settled before implementation.

### Scope is frozen for the turn

An operator who asked for a health summary has not authorized a directory walk
for the next five minutes. The exchanged token carries an explicit scope — the
tool ids of the turn — fixed **before any tool result enters the model's
context**, and the gateway enforces `tool ∈ scope`.

This is also the only defence against §6 that does not depend on the model
behaving.

---

## 5. The tool set

Tools only. Not resources, not prompts — the epic's premise is an agent asking
questions, which is model-controlled by definition; resources are
application-controlled ambient context, and a split surface would put the
ceiling in two places. Resources remain the right home for ambient estate health
in a console client later; that is additive.

| Tool | Returns | Capability |
|---|---|---|
| `estate_health` | dependency status per product | `read` |
| `estate_kpis` | headline metrics, including an honest 501 | `read` |
| `estate_inbox_counts` | queue depths only | `read` |
| `kora_resolution_outcomes` | window + aggregate outcomes | `read` |
| `estate_inbox_items` | items **including user-authored text** | `support` |
| `kora_user_activity` | per-user activity rows | `platform` |
| `estate_entities_search` | directory (**exposes email, see below**) | `platform` |
| `estate_audit_search` | audit rows | `platform` |

An autonomous machine user holds **`read` and nothing else**.

### The ceiling is a tool boundary, never a field filter

An earlier draft expressed the ceiling as endpoint names, and endpoints are not
projections. `GET /v1/admin/ai-metrics` returns a paged `users[]` keyed by user
UUID with an exact unpaged `total` and caller-controlled window bounds — so
"aggregates and health only" would have granted full active-user enumeration
plus a minute-resolution activity oracle, through an endpoint the same sentence
listed as safe.

**Rule for every product adopting this: a narrower principal must cause a
narrower QUERY.** Never a narrower serialization of the same result. Data that
is filtered after retrieval has already crossed into the gateway's logs, traces
and memory. Hence `kora_resolution_outcomes` and `kora_user_activity` are two
tools over one endpoint, at two capabilities, rather than one tool with a flag.

### Known exposure to weigh

`kora/api/internal/platformadmin/entities.go` renders a user's **email** into
`sublabel` when they have no handle — contrary to that endpoint's own doc
comment, which claims it never exposes an email. Pre-existing and not caused by
this design, but it means `estate_entities_search` is an email-disclosing tool
and is priced at `platform` accordingly.

### Volume is a threat, not just permission

A human paging a directory and an agent exporting it are the same authorization
decision and completely different events. `page` is currently uncapped
(`envelope.go` clamps `limit` to 200 and does not bound `page`). Every
row-returning tool carries its own limit and cursor — **MCP does not paginate
`tools/call` output** — plus a page ceiling, a per-principal request budget, and
a max-rows-per-session.

---

## 6. Untrusted content

**The protocol offers no mechanism here.** MCP has no content type or annotation
marking a substring as untrusted; its trust language runs the other way
(protecting clients from servers). "Tool output is data, never instruction" is a
statement of intent, and this document does not pretend otherwise.

The channel is unusually good for an attacker: an unresolved-food inbox item is
created by **any end user** with no admin action, its title is the user's raw
typed phrase, a `no_match` carries `high` severity, and the inbox sorts
oldest-first — so a planted item stays on page one indefinitely.

Defences, honestly graded:

1. **Scope freezing** (§4) — enforceable, ours, and independent of the model.
2. **Capability separation** — `estate_inbox_items` requires `support`, so an
   autonomous agent never receives user-authored text at all. The unwatched
   principal cannot reach the injection channel.
3. **Structural containment** — user text only inside a named field under
   `outputSchema` with explicit provenance, never interpolated into composed
   prose. A convention, not a boundary.
4. **Detection** — log the exact user-authored strings served to an agent
   principal, so an attempt is findable afterward.
5. **Write-side hygiene** — control-character stripping and length caps, as
   depth, explicitly not relied upon.

### Normative requirement on adopters

> **The security boundary is the agent's entire tool set, not this server's
> response.** An agent session holding these tools MUST NOT simultaneously hold
> egress tools — web fetch, ticket creation, outbound messaging. If it does,
> every ceiling here is irrelevant: injected instructions exfiltrate through
> capabilities this server cannot see.

This cannot be enforced by the gateway. It is stated normatively because a
copying product would otherwise inherit the assumption silently.

---

## 7. Protocol

**Target revision: 2026-07-28.** Pinned, because it decides the library and the
auth attachment point. That revision removed `initialize`, connection-scoped
sessions, and the GET/SSE stream; every request carries its own protocol version
and capabilities in `_meta`. The statelessness suits a per-request bearer token
and per-call audit.

- **Transport: Streamable HTTP.** stdio is disqualified twice: a scheduled
  remote agent cannot spawn a subprocess in-cluster, and stdio implementations
  take credentials from the environment, which destroys per-call identity.
- **Audience is this server's canonical URI** (RFC 8707 resource indicator),
  exact match, with `azp` checked. **Not** a Zitadel project id: two servers in
  one project would accept each other's tokens.
- **Protected Resource Metadata** at `/.well-known/oauth-protected-resource`,
  and `WWW-Authenticate` on every 401.
- **`tools/list` carries `cacheScope: "private"`** and a `ttlMs` no longer than
  the token's remaining life. `public` is the unprompted default and would let a
  shared gateway serve one principal's tool list to another — a hazard that
  exists only because the list is principal-scoped. Do not declare
  `listChanged`: the list is a function of the credential, not a mutable fact.
- Per-principal `tools/list` is explicitly permitted by this revision, which
  allows the set to "vary by the authorization presented on the request … since
  credentials are per-request input, not connection state".
- `GET`/`DELETE` on the endpoint → `405`. Required headers
  (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) must match the body.
  Validate `Origin` when present.

---

## 8. Failure semantics

Fail closed. Every rule below is normative, not inherited by copying an existing
parser.

**Verifier:**
- Asymmetric algorithms only. Reject `none`. Reject all HS\* — platform-api
  holds HMAC secrets, so an HS-accepting verifier is a live forgery path with a
  key already distributed.
- `kid` resolved only against configured JWKS. Never honour `jwk`, `jku`, `x5u`.
- Issuer exact-match against an allowlist. Never discovery driven by the token's
  own `iss`.
- `typ` pinned, so an ID token for the same audience cannot be replayed as an
  access token.
- Clock leeway 30s, far below the token TTL — otherwise the stated revocation
  propagation objective is false by construction.

**Statuses:**

| Condition | Answer |
|---|---|
| absent / unverifiable / expired / wrong audience or issuer | `401` + `WWW-Authenticate` |
| verified, capability check fails | `403` |
| server not configured | **`503`** |

A bare `404` is forbidden: a conforming client reads it as a legacy server and
downgrades to the deprecated 2024-11-05 transport, producing a confusing double
request. A product's own `404`-means-unmounted posture is unaffected — it simply
does not transfer to MCP.

Errors do not disclose which check failed; the log does. This declines the auth
spec's SHOULD to return `error="insufficient_scope"`, and is recorded here as a
**deliberate deviation**: there is no step-up flow to enable for a pre-provisioned
in-cluster principal.

Tool-level failures return `isError: true` inside the result so a model can
self-correct; JSON-RPC errors are for structural failures. Never emit a code
from the spec's reserved `-32020`–`-32099` range that the spec has not defined.

**Replay.** Single-use `jti` is rejected: it collides with the stateless retry
model and with multi-tool turns. Short TTL plus audience binding plus TLS is
proportionate for a read surface. Record `jti` on every audit row so replay is
detectable after the fact; do not gate on it. Sender-constraining (mTLS or DPoP)
is the answer if that changes, and is deferred, not overlooked.

**Revocation.** Short TTL plus de-provisioning at the issuer; the propagation
objective equals the TTL. A configured deny-list of agent subject ids, checked in
the verifier, is the break-glass lever — a handful of strings that do not scale
with users, and the only way to refuse a specific compromised agent before its
token expires.

---

## 9. Audit

**The audit row commits before any data leaves the process.** A read that cannot
be audited returns 500 and no data. Auditing after the response — or in a
goroutine — fails open, and an agent can induce that failure by driving its own
request rate.

Each row records: the agent, the operator it acted for (absent for autonomous),
principal kind, tool, `jti`, issuer, and request id. Identity is
`(issuer, subject)`, never `subject` alone: agent and human subjects share a
namespace and uniqueness is not guaranteed across issuers.

`tools/list` is itself audited. It discloses the shape of the caller's
authority, and it is the one call that can enumerate an operator's entitlements
without touching data.

### If agent attribution is later carried into products

A product's audit table typically has a single non-null actor. Kora's, for
example, has `actor_id` and `actor_email text NOT NULL CHECK (btrim(actor_email) <> '')`,
and its reader renders email-first with an id fallback — a fallback whose
comment already anticipates a system-written row. Two changes travel together
or not at all:

1. The projection: define how a delegated row renders in the contract's single
   `actor` string.
2. **The filter.** A reader that searches `actor_email = ? OR actor_id = ?` will
   silently miss every agent-mediated row for that person — the exact class the
   change exists to record. Shipping the column without the filter is worse than
   not shipping it.

---

## 10. Evidence

Byte-exact vectors are the wrong artifact here: nothing reproduces a signature,
it is verified. The artifact is a **decision table** — signed tokens from a test
keypair, plus the asserted principal, tool visibility and outcome for each.

Two property tests carry most of the weight:

1. **listed-set == callable-set.** For every principal in a fixture set, the
   tools `tools/list` returns are exactly the tools that do not 403 — iterated
   over the registry, never a hand-written list. This converts "hiding is not
   authorization" from a claim into a checked invariant, and is the only thing
   stopping the two checks drifting apart.
2. **The data boundary.** Over the union of every `read`-only tool's response,
   across parameter combinations, assert no field matches a user UUID or an
   email pattern. **This test fails today against `ai-metrics`** — it would have
   caught this design's worst defect before review, and it generalises to every
   product that adopts the pattern.

Named negative cases, each asserted: forged operator; expired grant; wrong
audience; wrong product; over-scoped capability; revoked agent (refused by the
deny-list before its token expires); malformed `act`; nested `act`; a hidden
tool called by name; and an autonomous principal attempting an operator-only
tool.

**Replay is asserted as DETECTION, not refusal.** §8 deliberately does not gate
on `jti`, so a replayed token succeeds. The test asserts that two audit rows
carry the same `jti` and are therefore distinguishable after the fact. Writing
this case as "a replayed token is refused" would fail, and the natural fix — 
re-introducing a single-use check — is the thing §8 rejected.

### Schema honesty, and one deliberate inversion

`outputSchema` is the lever. A tagged union rather than a nullable number; a
denominator with `"minimum": 1` makes an empty one *schema-invalid* rather than
a plausible `0.0`.

But a model reads the **serialized text**, not the schema. Against that audience
the estate's usual absence discipline is the weakest option: an absent key is
invisible, and the model will either omit the metric or infer something. So for
agent-facing output only:

> `{"first_try_rate": {"status": "not_instrumented"}}` — explicit status, not
> absence.

This is an audience-scoped exception to the rule applied everywhere else, and is
recorded so it is not "corrected" back. The parent epic's premise is right — a
value an operator reads as "not measured" is read by a model as an assertion of
zero — but the remedy that works for an operator is not the one that works for a
language model.

---

## 11. Rejected alternatives

**Per-product MCP servers.** §2. Two authorization owners for one row; N issuer
dependencies; every product re-implementing a verifier during an identity
migration.

**Reusing the products' HMAC scheme.** Its own package doc spends 47 lines on
load-bearing properties that each fail as a silent 401 — `url.QueryEscape` vs
`encodeURIComponent`, decoded path vs raw, newline ambiguity in `\n`-joined
fields, hex case. Three implementations are kept honest only by a byte-identical
vectors file. That is an N² problem; verification has no canonicalisation step
at all.

**The agent asserting its own operator header.** That field is trustworthy today
only because a signing service holds a secret; an agent holding it makes the
claim self-asserted.

**An agent as its own principal with no operator concept.** Discards identity we
genuinely have for operator-initiated calls, leaving the audit unable to answer
"who asked".

**Mesh/SPIFFE identity for the agent half.** Strongest guarantee — no bearer
secret at all — but no product consumes peer identity today and manifests live
in another repo. The delegation half is unchanged, so this remains an upgrade
path rather than a fork.

**Single-use `jti`.** §8.

---

## 12. Open items

These must be settled before implementation. None is a detail.

1. **Where both role sets come from** (§4). Blocking. Likely answer: intersect
   at the exchange, so the gateway verifies one already-intersected set.
2. **Whether Zitadel token exchange is available on our instance**, and its
   version. Upstream docs say it is enabled by default (a change from earlier
   releases, when it was flag-gated), but this must be checked against the
   instance rather than the docs. If unavailable, platform-api minting the token
   itself is an **either/or decided up front, never a runtime fallback** —
   accepting two issuers makes security that of the weaker one, and a minting
   service is an unconstrained delegation oracle unless what it may assert is
   stated.
3. **`may_act`.** RFC 8693 defines a claim for "this party may act for that
   one". The negative case "act present but agent not entitled to delegate"
   needs it, and Zitadel may not emit it.
4. **Small-N aggregates.** An aggregate over a population of one is per-user
   data. Products pre-launch or with small tenants need a minimum window
   granularity and k-anonymity suppression before `read` tools are safe.
5. **Agent lifecycle ownership.** Who provisions a machine user, where the agent
   registry lives, what de-provisioning looks like end to end, and how an
   operator answers "which agents can reach this data right now". Revocation
   names TTL as the mechanism but not the registry.
