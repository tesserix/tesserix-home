# Kora's MCP surface for platform agents

How a platform agent reads Kora's admin data over MCP: where the server lives,
what the platform already does for it, and the narrow set of things its author
must still build.

Status: **design, rewritten 2026-08-29 against the running platform. Not implemented.**
Origin: `tesserix/kora#511`.

> **This document was wrong once, in a way worth recording.** The first version
> put the MCP server inside `platform-api` and gave it its own principal model,
> capability intersection and principal-scoped `tools/list`. All of that already
> exists as platform infrastructure — a gateway, a registry and a rate limiter
> that were running while it was being written. The rewrite deletes what the
> platform owns and keeps only what it does not. §10 lists what changed and why,
> because the failure mode (designing against a diagram instead of the cluster)
> is more instructive than the conclusion.

## Contents

1. [The platform this fits into](#1-the-platform-this-fits-into)
2. [Where the code lives](#2-where-the-code-lives)
3. [Division of responsibility](#3-division-of-responsibility)
4. [Publishing and reachability](#4-publishing-and-reachability)
5. [Identity](#5-identity)
6. [The tool set and its ceiling](#6-the-tool-set-and-its-ceiling)
7. [What the server must still build](#7-what-the-server-must-still-build)
8. [Untrusted content](#8-untrusted-content)
9. [Evidence](#9-evidence)
10. [What changed from the first version](#10-what-changed-from-the-first-version)
11. [Open items](#11-open-items)

---

## 1. The platform this fits into

Running in `tesseract-prod-in-gke` today, verified by cluster read:

| Component | What it is |
|---|---|
| `agentgateway-system/agentgateway-mcp` | **Solo.io agentgateway v1.4.1**, a Gateway API `Gateway` (`gatewayClassName: agentgateway`) reconciled to XDS. The data plane for every `/mcp/...` request. |
| `agentgateway-system/agentgateway-ratelimit` | `envoyproxy/ratelimit` behind Valkey, attached to the MCP listener, keyed by `jwt.sub`, `failureMode: FailClosed`. |
| `agentregistry-system/agentregistry` | The catalog (`tesserix/agentic-registry`) — MCP server manifests, tool metadata, versions, visibility. |
| `mcp.tesserix.app` | Browser catalog UI and machine API, on separate trust boundaries (registry ADR-0001). |

The registry's own invariant governs everything below:

> It is deliberately **a catalog, not a proxy** … It never authenticates
> end-user traffic, mints tokens, proxies requests, or runs the artifacts it
> catalogs.

**Do not confuse two gateways.** `kora-ai` (which Kora's model calls already
traverse) and `agentgateway-mcp` are separate Gateway objects. Kora ADR-0002
governs the first and is about **A2A**, not MCP.

**There is no Kora MCP server today.** A recursive search of `tesserix/kora`
for `mcp` returns nothing, and no `kora-*` MCP backend exists in the cluster.
This is a from-scratch build, not an extension.

---

## 2. Where the code lives

**A new dedicated repository — `tesserix/kora-mcp`.** All MCP code lives there:
the server, its tool definitions, its Dockerfile, its deployment manifests and
its registry manifest.

### This is a new precedent, not existing practice

Stated plainly so nobody reads it as a restatement of what the org already does.
Neither existing pattern is a dedicated repo:

- **devai's** MCP servers (`analyst-mcp`, `gitops-mcp`, `sre-mcp`, `scm-mcp`)
  are domains mounted inside `devai-api`, in `tesserix/devai`.
- **homechef, mark8ly and platform** MCPs are one multi-tenant image,
  `services/mcp-gateway/` in `tesserix/slm-support-platform`, deployed three
  times with `MCP_TENANT` selecting the tool set.

What makes a server independently addressable and authorizable in both cases is
the **registry manifest and the gateway export**, not repo separation. A
dedicated repo therefore buys clarity of ownership and a clean blast radius, not
a capability. It is a deliberate choice to make the MCP surface's dependency on
Kora one-directional and explicit: `kora-mcp` calls Kora's public admin API and
holds no Kora source.

Anyone migrating the existing servers to this shape should treat this section as
the argument to weigh, not a mandate they have already violated.

---

## 3. Division of responsibility

The single most useful table in this document. Everything the platform owns is a
thing the server must **not** implement.

| Concern | Owner | Mechanism |
|---|---|---|
| Routing, the request path | **Gateway** | Gateway API `HTTPRoute` → `AgentgatewayBackend` |
| Caller authentication | **Gateway** | `AgentgatewayPolicy.traffic.jwtAuthentication`, Zitadel JWKS |
| Coarse admission | **Gateway** | `traffic.authorization` CEL over Zitadel project roles |
| **Per-caller tool filtering** | **Gateway** | `backend.mcp.authorization` — see below |
| Rate limiting | **Gateway** | `agentgateway-ratelimit`, keyed by `jwt.sub` |
| Upstream credential injection | **Gateway** | `backend.auth.secretRef`, from a `credentialRef` in the manifest |
| Catalog, versions, visibility, discovery | **Registry** | `MCPServer` artifacts, content-addressed tags |
| Desired state for the three routing GVKs | **Registry** | `GET /v0/export/agentgateway` → reconciler |
| **Tool implementations** | **Server** | §7 |
| **Object-level authorization** | **Server** | §7 — nothing else can do it |
| Schema honesty, limits, provenance | **Server** | §7 |

### Tool filtering is a gateway primitive, and it is unused

`AgentgatewayPolicy.backend.mcp.authorization` is a CEL rule set evaluated per
JWT claim. From the CRD's own schema:

> List operations, such as `list_tools`, will have each item evaluated. **Items
> that do not meet the rule will be filtered.** Get or call operations, such as
> `call_tool`, will evaluate the specific item and reject requests that do not
> meet the rule.

That is precisely what the first version of this document implemented inside the
server. **No deployed MCP server sets it today** — the capability is
unconfigured, not delegated away. Kora's should be the first to use it, and §11
records that as the open item it is.

The registry's export also has a `requireServerScope` flag (default `false`)
that renders a per-route policy requiring an `mcp:<tenant>:<server>` scope. Both
are opt-in and must be requested by whoever registers the server; nothing turns
them on automatically.

---

## 4. Publishing and reachability

Publication and reachability are the same act, which resolves a question
`kora#513` raised.

1. Author an `MCPServer` manifest — `apiVersion: registry.agentic.dev/v1alpha1`.
   Its `spec` **is** the MCP-Registry `server.json`, so it round-trips with the
   upstream registry.
2. Publish: `agentic apply -f`, or CI `POST /v0/apply` with a tenant-scoped
   deploy key.
3. The registry renders `AgentgatewayBackend` + `HTTPRoute` (+ policy) via
   `GET /v0/export/agentgateway`; a namespace-scoped reconciler applies them.
4. The gateway converts them to XDS and begins serving
   `/mcp/<tenant>/<server>`.

**The registry is the sole writer** of those three GVKs in `agentgateway-system`
(registry ADR-0003). Hand-applied YAML fights the reconciler's prune loop — so
routing for this server is never configured by hand, and never by Kora.

**Credentials are references, never values.** A manifest declares
`credentialRef: {secretName, key, header, prefix}`; a manifest carrying an inline
`value`/`token`/`apiKey`/`secret` is **rejected at `/v0/apply`**. The gateway
injects the upstream credential, so the calling agent presents only its own
Zitadel token and never holds Kora's.

---

## 5. Identity

Two identities, and the distinction is the whole of it.

**Caller → gateway.** A Zitadel JWT, validated by the gateway against JWKS with
audience and issuer pinned. The server never verifies this token, never
discovers an issuer, never holds a JWKS. Coarse admission is a project role
(`agentgateway.mcp` today, which is gateway-wide and not per-server).

**Gateway → Kora.** The gateway injects a brokered credential from a Secret. The
server calls Kora's existing platformauth admin surface with it, exactly as any
other signed caller does — so **Kora's admin API is unchanged by this design**,
and its "Kora does not own the privilege model" posture is preserved rather than
contradicted.

**The acting identity reaches the server as gateway-terminated trusted context**
— a verified claim or a header the gateway set — and **never as a tool
argument**. Kora issue #384 states the rule directly ("accept no user ID in tool
arguments"), and every existing server implements it: `slm-support-platform`'s
`_trusted_ctx()`, homechef's HMAC-signed identity headers, devai's
`ToolContext.triggered_by`. A model-supplied user id is an attacker-supplied
user id.

There is no RFC 8693 token exchange here, no `act` claim, no delegated-vs-
autonomous principal type, and no `jti` replay store. §10 explains why those
went.

---

## 6. The tool set and its ceiling

Tools only — not resources, not prompts. The premise is an agent asking
questions, which is model-controlled by definition.

| Tool | Returns | Required claim |
|---|---|---|
| `kora_health` | dependency status | `read` |
| `kora_kpis` | headline metrics, including an honest 501 | `read` |
| `kora_inbox_counts` | queue depths only | `read` |
| `kora_resolution_outcomes` | window + aggregate outcomes | `read` |
| `kora_inbox_items` | items **including user-authored text** | `support` |
| `kora_user_activity` | per-user activity rows | `platform` |
| `kora_entities_search` | directory (**discloses email**) | `platform` |
| `kora_audit_search` | audit rows | `platform` |

The required claim is enforced by **`backend.mcp.authorization` at the gateway**,
not by the server. The server's job is to make each tool a distinct, separately
authorizable unit so the gateway has something to filter on.

### The ceiling is a tool boundary, never a field filter

This rule survives the rewrite unchanged, because it is a property of the tool
surface rather than of where the server runs.

An earlier draft expressed the ceiling as endpoint names. Endpoints are not
projections: `GET /v1/admin/ai-metrics` returns a paged `users[]` keyed by user
UUID with an exact unpaged total and caller-controlled window bounds, so
"aggregates only" would have granted full active-user enumeration plus a
minute-resolution activity oracle — through an endpoint the same sentence listed
as safe.

**A narrower principal must cause a narrower QUERY.** Never a narrower
serialization: data filtered after retrieval has already crossed into the
server's logs, traces and memory. Hence `kora_resolution_outcomes` and
`kora_user_activity` are two tools over one endpoint, and Kora shipped
`?sections=outcomes` (kora#525, merged) so the narrow tool drives a narrow query
rather than fetching rows it must then drop.

### Known exposure to price, not to fix

`kora/api/internal/platformadmin/entities.go` renders a user's **email** into
`sublabel` when they have no handle. That is deliberate and documented — a
directory that cannot tell two people called "Alex" apart does not do its job —
and correct for a human operator paging a console. It is a different question
when a tool hands the same rows to a model, and thence to that model's context,
logs and provider. So `kora_entities_search` is an email-disclosing tool, priced
at `platform`. Nothing asks Kora to change.

---

## 7. What the server must still build

Everything below is a gap in the platform, not a choice. Neither the gateway nor
the registry can do any of it.

- **Object-level authorization.** Cross-user access returns 404. Neither the
  gateway nor the registry knows Kora's ownership graph, and every existing MCP
  server reimplements this itself. This is the single most important server-side
  responsibility.
- **Deriving the acting identity from trusted context** (§5) and refusing to
  read it from a tool argument.
- **Input validation and output limits.** `tools/call` output is **not
  paginated by the MCP protocol** — only the list operations are. Every
  row-returning tool carries its own limit and cursor. Kora's own `page` is
  capped (kora#524), but that is a query-cost bound and not a row budget.
- **Schema honesty**, including the inversion below.
- **Injection safety** of returned content (§8).
- **The registry manifest**, and the decision to opt into
  `backend.mcp.authorization` and `requireServerScope`.

### Schema honesty, and one deliberate inversion

`outputSchema` is the lever: a tagged union rather than a nullable number, and
`"minimum": 1` on a denominator makes an empty one *schema-invalid* rather than
a plausible `0.0`.

But a model reads the **serialized text**, not the schema. Against that audience
the estate's usual absence discipline is the weakest option — an absent key is
invisible, and the model will omit the metric or infer something. So for
agent-facing output only:

> `{"first_try_rate": {"status": "not_instrumented"}}` — explicit status, not
> absence.

This is an audience-scoped exception to the rule applied everywhere else (a UUID
header omitted rather than zeroed; `sublabel` absent rather than `""`;
`first_try_rate_pct` absent rather than `0.0`). Recorded so nobody corrects it
back.

---

## 8. Untrusted content

**The protocol offers no mechanism here.** MCP has no content type or annotation
marking a substring as untrusted, and its trust language runs the other way —
protecting clients from servers. "Tool output is data, never instruction" is a
statement of intent, and this document does not pretend otherwise.

The channel is unusually good for an attacker: an unresolved-food inbox item is
created by **any end user** with no admin action, its title is the user's raw
typed phrase, a `no_match` carries `high` severity, and the inbox sorts
oldest-first — so a planted item stays on page one indefinitely.

What actually helps, honestly graded:

1. **Capability separation** (enforceable, and now the gateway's):
   `kora_inbox_items` requires `support`, so a caller holding only `read` never
   receives user-authored text at all.
2. **Structural containment** (server-side, partial): user text only inside a
   named field under `outputSchema` with explicit provenance, never interpolated
   into composed prose. A convention, not a boundary.
3. **Detection** (server-side, cheap, currently absent): log the exact
   user-authored strings served to an agent, so an attempt is findable
   afterward.

### The boundary is the agent's whole tool set

> An agent session holding these tools MUST NOT simultaneously hold egress tools
> — web fetch, ticket creation, outbound messaging. If it does, every ceiling
> here is irrelevant: injected instructions exfiltrate through capabilities
> neither Kora nor the gateway can see.

Stated normatively because nothing in this stack enforces it. The Tesserix ADK
gives the calling agent an independent allowlist — *"trusted descriptions,
required scopes, and approval policy come from ADK configuration, never from an
MCP server's untrusted annotations"* — which is where this belongs, and is a
second narrowing on top of the gateway's.

---

## 9. Evidence

- **Object-level authorization** is the thing to test hardest, because it is the
  thing only the server can get wrong: cross-user access returns 404, asserted
  per tool.
- **The data boundary.** Over the union of every `read`-tier tool's response,
  across parameter combinations, assert no field matches a user UUID or an email
  pattern. *This test fails today against `ai-metrics` if the aggregate-only
  path is not used* — it is what would have caught the first version's worst
  defect, and it generalises to any product joining the surface.
- **Identity provenance:** a tool argument naming a user id is refused, not
  honoured.
- **Gateway policy is verified in the deployed environment, not asserted in
  unit tests.** `backend.mcp.authorization` is Kubernetes state; the test is a
  signed call with a narrow claim observing the wide tool absent from
  `tools/list` and refused on `tools/call`.

Byte-exact signing vectors are **not** an artifact here: the server verifies no
signature and mints no token. That was an artifact of the rejected design.

---

## 10. What changed from the first version

Kept, because they are properties of the tool surface and independent of
topology: the ceiling as a tool boundary (§6), the untrusted-content position
(§8), and schema honesty including the LLM-audience inversion (§7).

Deleted, because the platform owns them:

| Removed | Now owned by |
|---|---|
| MCP server as a `platform-api` module | its own repo; gateway routes to it |
| A principal model with delegated/autonomous kinds | gateway JWT validation |
| RFC 8693 `act` claim, token exchange, `may_act` | nothing — no exchange exists in this path |
| Capability intersection in the server | `backend.mcp.authorization` |
| Principal-scoped `tools/list` | `backend.mcp.authorization` (same primitive) |
| Verifier hardening rules (alg, `kid`, `iss`, `typ`) | gateway JWT validation |
| Single-use `jti` replay store | never needed; gateway is the trust boundary |
| Per-principal rate limits and row budgets | `agentgateway-ratelimit` (row budgets remain, §7) |
| An audit schema change in Kora | gateway access logs; Kora's audit is unchanged |

**Why it went wrong.** The first version was written against an architecture
diagram and four specialist reviews, none of which asked whether the platform
already existed. It did — the MCP gateway was 88 days old. Kora's own AI calls
already traverse `kora-ai.agentgateway-system.svc.cluster.local`, which was in
the working notes throughout. The reviews were scoped to the design's internal
coherence rather than to its premises, so they sharpened a wrong answer.

The check that would have caught it costs one command: `kubectl get deploy -A`.

---

## 11. Open items

1. **`backend.mcp.authorization` has never been used.** Kora's would be the
   first. The CEL rules, the claim they read, and how a claim maps to the
   `read`/`support`/`platform` tiers all need designing and proving in a
   non-production namespace before this ships.
2. **Coarse admission is gateway-wide today.** Every caller holding
   `agentgateway.mcp` reaches every route on the public listener. Per-server
   scope (`requireServerScope`) is off by default. Decide before publishing,
   not after.
3. **Which credential the gateway brokers to Kora**, and whether Kora's
   platformauth admin surface is the right upstream or whether a narrower
   internal surface should exist for this caller.
4. **Tenancy.** The route is `/mcp/<tenant>/<server>` and the manifest carries
   `mcp.tesserix.app/tenant`. Kora is single-tenant; confirm the label is
   `kora` and that nothing about the estate's tenancy leaks into tool
   semantics.
5. **Whether the ADK's `McpServer` adapter should be used** rather than a
   hand-rolled server. It already provides tenant scoping, redaction and
   approval gates; the trade is a Python dependency for a Go product.
