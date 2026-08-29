# Catalog Read Endpoint Implementation Plan (#427)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a stable, versioned, cacheable HTTP endpoint that serves the console's published plan catalog for a Stripe mode, so mark8ly can stop compiling prices into `internal/billing/pricing/catalog.go`.

**Architecture:** One Next.js route handler in `apps/console/app/api/`, composed from repository functions that already exist — `readLivePublication(mode)` for the revision pointer and publish metadata, `readCatalogRows(mode, source)` for the rows. The work is not the query; it is the **contract**, the **cache policy**, and the **authentication**, because another repository's runtime path pins to all three.

**Tech Stack:** Next.js 16 route handler (TypeScript), `@tesserix/platform-auth` (Zitadel bearer verification, capabilities), PostgreSQL via the existing `plan-catalog-repo`, pnpm.

**Spec:** [tesserix-home#427](https://github.com/tesserix/tesserix-home/issues/427). Counterpart: tesserix-home#328. Consumers: mark8ly#304 (cached, fail-open read) and mark8ly#305 (onboarding snapshot).

## Global Constraints

- **The response shape is a PUBLISHED CONTRACT.** mark8ly pins to it. Changing a field later is a breaking change to another repository's runtime path, not a view tweak. Design it once, document it at the route, and treat additions as the only safe change.
- **BACKLOG §P: no new runtime dependency on the console for the checkout / subscription hot path.** This is why mark8ly's read is cached and fail-open, and it constrains this endpoint too: an endpoint whose *availability* becomes load-bearing for checkout violates the constraint the design was built around. It must be safe for mark8ly to serve stale data when this endpoint is down.
- **Auth is a Zitadel machine identity presenting a bearer token**, verified with the console's existing `@tesserix/platform-auth`. Decided in #427 after rejecting three alternatives. **Do not** invent a shared-secret header: `app/api/internal/parity-check/route.ts`'s docstring argues against exactly that, on the grounds it would add a second auth scheme to the console and make a route reachable without an identity. **Do not** reuse the operator-session convention: the caller is a machine on a runtime path with no session to mint.
- **Least privilege.** See Task 1's ruling — a machine that reads published prices must not thereby hold the console's whole `billing` surface.
- **`pnpm --filter console exec vitest run`, `lint`, `tsc --noEmit`, and `build` are all required gates.** Note the `exec`. `tsc` and `vitest` cannot see server-only code reaching the browser bundle; only `build` catches that.
- Console is pnpm with hoisted `node_modules`; a fresh worktree needs `pnpm install` and three workspace packages built from gitignored `dist/`.

---

### Task 1: The capability, and the identity that carries it

**Files:**
- Modify: `packages/console-core/../platform-auth/src/capabilities.ts` — i.e. `packages/platform-auth/src/capabilities.ts`
- Test: `packages/platform-auth/src/capabilities.test.ts`

**Interfaces:**
- Produces: a new `Capability` literal that Task 3's route asserts. Task 3 consumes exactly this string.

**RULING, made in the plan and flagged so it can be overturned:** add a **narrow, purpose-named capability** rather than granting a machine the existing `billing` surface.

The vocabulary today is `read` (console entry only), four SURFACE capabilities that say *where an operator works* (`crm`, `support`, `billing`, `platform`), and seven RISK capabilities that say *what may be done* (`publish-catalog`, `hard-delete`, …). A machine is not an operator, does not enter the console, and works in no surface — so no existing capability fits without over-granting. `billing` would hand a price reader the console's entire billing surface.

Name it for the job, e.g. `read-plan-catalog`. **Cost if wrong:** one more string in a shared vocabulary; the alternative is a service account holding a surface it never uses.

- [ ] **Step 1: Write the failing test**

Add to `capabilities.test.ts`, matching the file's existing conventions:

```ts
it("maps the plan-catalog read role to its capability", () => {
  expect(toCapabilities(["read-plan-catalog"])).toContain("read-plan-catalog");
});

it("does not grant the billing surface to a plan-catalog reader", () => {
  // A machine that reads published prices must not thereby hold the console's
  // billing surface. This is the whole reason the capability exists.
  expect(toCapabilities(["read-plan-catalog"])).not.toContain("billing");
});

it("does not let the console-entry capability imply it", () => {
  expect(toCapabilities(["read"])).not.toContain("read-plan-catalog");
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter @tesserix/platform-auth exec vitest run src/capabilities.test.ts
```

Expected: FAIL — the capability does not exist.

- [ ] **Step 3: Add the capability**

Add `"read-plan-catalog"` to `CAPABILITIES`. Read the file's existing comment style first — each entry argues for itself. Yours must say: it is held by **machines, not operators**; it grants reading the *published* catalog and nothing else; and it deliberately does not imply, and is not implied by, `billing`.

Decide from the file whether it belongs in `SURFACE_CAPABILITIES` or `RISK_CAPABILITIES` — read both lists' doc comments. It is plausibly **neither**, since those lists describe an operator's console. If it belongs to neither, say so in a comment rather than forcing it into one.

- [ ] **Step 4: Run the package suite**

```bash
pnpm --filter @tesserix/platform-auth exec vitest run
```

Expected: PASS. If an existing test asserts an exhaustive capability list or a count, update it to state the new truth — do not loosen it.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-auth/src/capabilities.ts packages/platform-auth/src/capabilities.test.ts
git commit -m "feat(platform-auth): add the read-plan-catalog capability for machine callers"
```

---

### Task 2: Machine-token verification

**Files:**
- Modify: `packages/platform-auth/src/zitadel.ts`
- Test: `packages/platform-auth/src/zitadel.test.ts`

**Interfaces:**
- Consumes: Task 1's capability.
- Produces: a function Task 3 calls to turn an `Authorization` header into a verified machine identity or a typed rejection. Name it and state its exact signature in your report — Task 3 depends on it.

**Read `zitadel.ts` fully first.** It verifies operator tokens today, and two of its assumptions do not hold for a machine:

1. **`ZitadelIdentity` requires `email`.** A Zitadel *service user* may not have one. Decide deliberately: either widen the identity type so `email` is optional for machines, or return a distinct machine-identity type. Do not fabricate a placeholder email — a synthetic identity in an audit trail is worse than an absent field.
2. **`getZitadelConfig()` reads `ZITADEL_CLIENT_ID`, described as "OIDC client id of the `apps/web` application".** A machine token minted for a different client will carry a different `aud`. Establish what audience a service-user token actually presents before writing the check, and if the audience must differ, add configuration for it rather than relaxing the check.

**If verifying the token requires configuration that does not exist yet** (an audience, a JWKS URL, a project id), do not invent values — implement against the config and report exactly which environment variables must be provisioned. Task 5 provisions them.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:

```
- a valid machine token -> a verified identity carrying its roles
- a token with a wrong/absent audience -> rejected
- an expired token -> rejected
- a token signed by the wrong key -> rejected
- a malformed or absent Authorization header -> rejected, distinctly from an invalid token
- an operator token -> either accepted-as-identity or rejected, but the behaviour is
  ASSERTED either way rather than left undefined
```

Reuse the file's existing JWKS/signing test helpers rather than building a second harness.

- [ ] **Step 2: Run and confirm they fail**

```bash
pnpm --filter @tesserix/platform-auth exec vitest run src/zitadel.test.ts
```

- [ ] **Step 3: Implement, then re-run**

Expected: PASS, and the rest of the package still green.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(platform-auth): verify Zitadel machine tokens for service callers"
```

---

### Task 3: The route

**Files:**
- Create: `apps/console/app/api/v1/plan-catalog/route.ts`
- Create: `apps/console/app/api/v1/plan-catalog/route.test.ts`

**Interfaces:**
- Consumes: Task 1's capability, Task 2's verifier, and `readLivePublication` / `readCatalogRows` from `@/lib/db/plan-catalog-repo`.
- Produces: `GET /api/v1/plan-catalog?mode=<test|live>` — the published contract.

**Path is versioned in the URL** (`/api/v1/...`) because mark8ly pins to it and the estate's other versioned surfaces do the same. A breaking change becomes `/api/v2/...` rather than a silent shape change.

- [ ] **Step 1: Write the failing tests**

Model the file on `app/api/internal/parity-check/route.test.ts` for structure. Cover:

```
- an unauthenticated request -> 401, and NO catalog data in the body
- a token without read-plan-catalog -> 403, distinct from 401
- an unknown or absent `mode` -> 400 naming the accepted values, never a default
- a mode that has never been published -> 404 (readLivePublication returns null),
  NOT 200 with an empty list: "no catalog" and "an empty catalog" are different answers
- a published mode -> 200 with the documented shape, including the revision id
- the response carries an explicit Cache-Control and an ETag derived from the revision id
- a conditional request whose If-None-Match matches -> 304 with no body
- a database failure -> 5xx, and no partial or half-built catalog in the body
```

The 404-vs-empty-200 case is the one that matters most: mark8ly caches this, and caching "the catalog is empty" is materially worse than caching nothing.

- [ ] **Step 2: Run and confirm they fail**

```bash
pnpm --filter console exec vitest run app/api/v1/plan-catalog/route.test.ts
```

- [ ] **Step 3: Implement the route**

Response shape — document it in the route's own docstring as a published contract, and state there that additive changes are the only safe ones:

```jsonc
{
  "mode": "test",
  "revision_id": "…",          // the version; mark8ly pins and revalidates on this
  "published_at": "…",          // ISO 8601, UTC
  "prices": [
    {
      "lookup_key": "…",
      "plan": "…",
      "period": "…",
      "tier": "…",
      "currency": "…",
      "unit_amount_minor": 0,   // minor units, per §4.2's money convention
      "tax_behavior": "…"
    }
  ]
}
```

`published_by` is **deliberately excluded**: it names an operator, and this response crosses a repository boundary into a product's runtime path. It is available on the console's own surface where an operator can be identified appropriately.

**Cache-Control must be explicit and stated with its reasoning.** A catalog changes only on publish, so it is highly cacheable; but a stale price is a wrong price. Pick a short `max-age` with `stale-while-revalidate`, or `no-cache` with the ETag doing the work, and say in a comment why that trade was chosen. Do not leave the header to a framework default — an unstated cache policy is the one thing every consumer will guess differently.

**The `source` argument to `readCatalogRows` is required and must not be defaulted.** The repo's own comments say so. If a second catalog source ever exists, a defaulted `source` silently serves the wrong one — the same class of blindness recorded in tesserix-home#392.

- [ ] **Step 4: Run every gate**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter console exec vitest run
pnpm --filter console lint
pnpm --filter console exec tsc --noEmit
pnpm --filter console build
```

All four. Paste real output for each.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/api/v1/plan-catalog"
git commit -m "feat(console): publish the plan catalog read endpoint for product consumers"
```

---

### Task 4: Document the contract where consumers will look

**Files:**
- Create: `docs/api/plan-catalog-read.md` (or the estate's existing API-doc location — look before creating)

**Interfaces:** none. This is the artefact mark8ly's implementer reads.

- [ ] **Step 1: Write it**

State: the URL and version, the auth scheme and how a product obtains a token, the exact response shape field by field, the cache policy and the ETag contract, every status code and what it means, and — explicitly — that **404 means the mode has never been published, which is not the same as an empty catalog**.

Include the §P constraint: consumers must cache and fail open, because this endpoint's availability must never become load-bearing for checkout.

- [ ] **Step 2: Commit**

```bash
git commit -am "docs(api): the plan catalog read contract"
```

---

### Task 5: Provision the machine identity, and prove it end to end

**Files:** whatever Task 2 reported as required configuration, plus the tesserix-k8s chart supplying the console's environment.

**This task is a live-system gate, not a diff.** #427 unblocks mark8ly#304 only when a token minted by mark8ly's identity actually returns a catalog.

- [ ] **Step 1: Register the service identity**

Create the Zitadel service user, grant it the `read-plan-catalog` role, and record where its
credentials live. Do not commit a secret.

**Four things execution established that are not obvious, and each fails confusingly:**

1. **The role is the THIRD copy of a tested vocabulary.** It exists in Zitadel's project roles,
   `packages/platform-auth/src/capabilities.ts`, and `platform-api/internal/platform/auth/capabilities.go`.
   `capabilities_contract_test.go` reads the TypeScript from disk and asserts the Go slice matches in
   count *and order* — it caught exactly this drift in CI. Zitadel is the copy **no test can check**.
   A role key that does not match exactly is dropped at the boundary, so the caller authenticates
   successfully and then gets a 403 with nothing explaining why.
2. **The access token must be a JWT.** Zitadel issues opaque tokens by default, and
   `verifyMachineAuthHeader` calls `jwtVerify`, which cannot verify one. Set the application's token
   type to JWT.
3. **Roles must be asserted into the token.** Without that setting the roles claim is absent,
   `extractRoles` returns `[]`, and the failure again presents as a permissions problem rather than a
   configuration one.
4. **The claim names are fixed:** roles at `urn:zitadel:iam:org:project:roles` (an object whose KEYS
   are the role names — `extractRoles` takes `Object.keys`), org at `urn:zitadel:iam:org:id`.
   If `ZITADEL_INTERNAL_ORG_ID` is set, the service user must be in that org; `verifyMachineAuthHeader`
   enforces it when configured, and role alone gates when it is not.

The `aud` cannot be derived from the code — it must be read off a real minted token, which is why
`ZITADEL_MACHINE_AUDIENCE` exists as its own variable rather than defaulting to `ZITADEL_CLIENT_ID`.
Defaulting it that way would let a browser-flow token reaching this path pass as a machine credential.

- [ ] **Step 2: Provision whatever Task 2 named**

Any new environment variable goes in `values-prod.yaml`, never as a helm parameter — a parameter added in git is a silent no-op that still reports `Synced`. Bump the chart version; `ct lint` fails a changed chart whose version did not move.

- [ ] **Step 3: Prove it against the deployed console**

Wait for the rollout — not merely for ArgoCD to report `Synced`, which it will do against a revision predating the merge. Then:

- unauthenticated → **401**
- a token lacking the capability → **403**
- the real machine token → **200** with a `revision_id` matching the mode's current publication
- the same request with `If-None-Match` → **304**

`curl` is not installed in this environment; use `python3 -c "import urllib.request; ..."`.

- [ ] **Step 4: Record the evidence and hand off**

Append the observed statuses to #427, then comment on **mark8ly#304** and **mark8ly#305** that the endpoint is live, linking the contract doc — and remove `blocked:console` from both, which is the moment that label finally becomes wrong.

---

## Status at time of writing

Tasks 1-4 are merged (#431). The endpoint is deployed and **fails closed**: `ZITADEL_MACHINE_AUDIENCE`
is unprovisioned, so `getZitadelMachineConfig` throws and the route answers 5xx rather than serving a
catalog. It cannot leak data before it is configured.

Task 5 is split — the Zitadel side is a human's to do, the provisioning and the live proof are not.
`blocked:console` stays on mark8ly#304 and #305 until the live proof passes: the label comes off on
evidence, not on a merge.

## What this unblocks

mark8ly#304 (the cached, fail-open read replacing `catalog.go`) and mark8ly#305 (the onboarding snapshot). Those are where most of the remaining work lives.

It does **not** unblock mark8ly#303, #366 or #371 — those wait on the parity window and on **mark8ly#459**, where a published price change can currently be a silent no-op because bootstrap reuses an existing `lookup_key` without comparing the amount.
