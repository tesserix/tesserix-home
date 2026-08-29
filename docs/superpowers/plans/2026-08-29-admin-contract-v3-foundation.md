# Contract v3 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Product Admin Integration Contract's closed endpoint vocabulary from nine ids to seventeen — eight new ids across seven surfaces, since onboarding is two endpoints — publish it, and redeclare mark8ly against it — so the eight surfaces the console cannot reach become declarable, checkable, and federatable.

**Architecture:** The conformance runner is already fully generic: `runner.ts` loops `ENDPOINT_IDS`, and envelope/money/timestamp/error/empty checks all dispatch off the `ENDPOINTS` record. Adding an id therefore adds its wire checks for free. The work is (a) eight `ENDPOINTS` entries with the right `envelope` and `probe` values, (b) the tests that pin them, (c) a published minor, (d) the declaration landed in **both** copies plus the Go-side cross-repo mirror.

**Tech Stack:** TypeScript, vitest, tsup, changesets (`@tesserix/admin-conformance`); Go + testify (mark8ly's guard test); Helm (tesserix-k8s ConfigMap).

**Spec:** `tesserix-home/docs/superpowers/specs/2026-08-29-admin-contract-v3-console-federation-design.md`, which amends `tesserix-home/docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md` as its §9.

## Global Constraints

- **Add, never rename.** `contract.ts:1-11` — a renamed id silently turns a product's declaration into "not implemented", which reports as a *pass*. Every id in this plan is final on merge.
- **Publish before declaring.** Design §9. A declaration naming a v3 id against a published 0.7.0 suite throws on the unknown key and fails the *entire* run. Order: publish → verify on registry → declare.
- **`>=0.5.0 <1.0.0` stays.** `tesserix-k8s/charts/apps/mark8ly-marketplace-api-admin/values.yaml:262`. Do not narrow it, do not pin exact. The range is what makes a minor reach the CronJob with no chart change.
- **Both declaration copies, same PR.** `mark8ly/admin-conformance.json` and `tesserix-k8s/charts/apps/mark8ly-marketplace-api-admin/templates/admin-conformance-configmap.yaml`. `conformance_declaration_test.go` fails on drift. De-duplicating them is #290's follow-up and is out of scope.
- **Three repos, three PRs**, in this order: `design-system` → `tesserix-k8s` + `mark8ly`. Never one squashed change.
- **`break-glass` is NOT declared in this plan.** It needs `--capability rotate-credentials` on the CronJob and a verified signing identity — that is V4's work (design §9.1). Plan 0 adds the *id*; V4 declares it.
- Semver: this is a **minor** (`0.7.0` → `0.8.0`). New ids are additive; nothing existing changes shape.

---

### Task 1: The eight new contract ids

**Files:**
- Modify: `design-system/packages/admin-conformance/src/contract.ts:13-120` (inside `ENDPOINTS`, after `lifecycle/reason-codes`)
- Test: `design-system/packages/admin-conformance/src/contract.test.ts` (create — there is no test file for `contract.ts` today)

**Interfaces:**
- Consumes: `ENDPOINTS`, `EndpointId`, `ENDPOINT_IDS`, `isEndpointId`, `isProbed` — all already exported from `contract.ts`.
- Produces: eight new `EndpointId` literals — `"outbox"`, `"email-sends"`, `"notifications"`, `"break-glass"`, `"conversions"`, `"onboarding/funnel"`, `"onboarding/sessions"`, `"tenant-purge"`. That is eight strings for seven *surfaces*: onboarding is two endpoints. Later tasks and every vertical plan key off these exact strings.

- [ ] **Step 1: Write the failing test**

Create `design-system/packages/admin-conformance/src/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { ENDPOINTS, ENDPOINT_IDS, isEndpointId, isProbed } from "./contract"

describe("contract v3 ids", () => {
  const V3_IDS = [
    "outbox",
    "email-sends",
    "notifications",
    "break-glass",
    "conversions",
    "onboarding/funnel",
    "onboarding/sessions",
    "tenant-purge",
  ] as const

  it("recognises every v3 id", () => {
    for (const id of V3_IDS) expect(isEndpointId(id)).toBe(true)
  })

  it("keeps the v2 ids, unrenamed", () => {
    // Renaming one turns a product's declaration into "not implemented",
    // which reports as a pass. This is the guard against that.
    for (const id of [
      "kpis",
      "inbox",
      "audit-logs",
      "entities",
      "health",
      "billing/subscriptions",
      "billing/trials",
      "tenant-lifecycle",
      "lifecycle/reason-codes",
    ]) {
      expect(ENDPOINT_IDS).toContain(id)
    }
  })

  it("fixes the envelope each v3 read answers", () => {
    expect(ENDPOINTS.outbox.envelope).toBe("data-pagination")
    expect(ENDPOINTS["email-sends"].envelope).toBe("data-pagination")
    expect(ENDPOINTS.notifications.envelope).toBe("data-pagination")
    expect(ENDPOINTS["break-glass"].envelope).toBe("data-pagination")
    expect(ENDPOINTS["onboarding/sessions"].envelope).toBe("data-pagination")
    expect(ENDPOINTS["onboarding/funnel"].envelope).toBe("data-flat-map")
    expect(ENDPOINTS.conversions.envelope).toBe("free")
    expect(ENDPOINTS["tenant-purge"].envelope).toBe("free")
  })

  it("refuses to probe the two endpoints a run must not call", () => {
    // A run that purged a real tenant is unrecoverable; a run that looked up
    // a real person by email is a scheduled PII read. Neither is a check.
    expect(isProbed("tenant-purge")).toBe(false)
    expect(isProbed("conversions")).toBe(false)
  })

  it("probes every other v3 read", () => {
    for (const id of [
      "outbox",
      "email-sends",
      "notifications",
      "break-glass",
      "onboarding/funnel",
      "onboarding/sessions",
    ] as const) {
      expect(isProbed(id)).toBe(true)
    }
  })

  it("gives every endpoint a path under /admin and a section", () => {
    for (const id of ENDPOINT_IDS) {
      expect(ENDPOINTS[id].path.startsWith("/admin")).toBe(true)
      expect(ENDPOINTS[id].section).toMatch(/^\d+\.\d+$/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system/packages/admin-conformance
pnpm vitest run src/contract.test.ts
```

Expected: FAIL — `isEndpointId("outbox")` returns `false`, and `ENDPOINTS.outbox` is `undefined` so the envelope assertions throw.

- [ ] **Step 3: Write minimal implementation**

In `src/contract.ts`, insert these entries inside the `ENDPOINTS` object, immediately after the `"lifecycle/reason-codes"` entry and before the closing `} as const`:

```ts
  /**
   * §9.1 — the transactional outbox's undelivered and failed rows.
   *
   * `SlugsImplementing`, never `Slugs`: a product without an outbox has no
   * outbox, and that is not a 501 worth rendering in the console.
   */
  outbox: {
    id: "outbox",
    method: "GET",
    path: "/admin/outbox",
    section: "9.1",
    envelope: "data-pagination",
    summary: "Undelivered and failed outbox rows (contract v3).",
  },
  "email-sends": {
    id: "email-sends",
    method: "GET",
    path: "/admin/email-sends",
    section: "9.2",
    envelope: "data-pagination",
    summary: "Transactional email delivery log (contract v3).",
  },
  /**
   * §9.3 — the product's own notification log.
   *
   * NOT the console's notification bell, which is derived from ticket rows
   * and has no table behind it. Two different things with one word; see the
   * design's §1.1 before wiring either into the other.
   */
  notifications: {
    id: "notifications",
    method: "GET",
    path: "/admin/notifications",
    section: "9.3",
    envelope: "data-pagination",
    summary: "Product-owned notification log (contract v3).",
  },
  /**
   * §9.4 — the emergency-account inventory.
   *
   * The first READ in the estate gated on an exact capability VALUE
   * (`rotate-credentials`). A run that does not send one gets a 403 — the
   * endpoint working correctly, reported as a failure — so the caller must
   * pass `--capability rotate-credentials`. Probed, but only usefully so
   * once the signing identity holds that capability.
   */
  "break-glass": {
    id: "break-glass",
    method: "GET",
    path: "/admin/break-glass",
    section: "9.4",
    envelope: "data-pagination",
    summary: "Emergency-account inventory; requires the rotate-credentials capability (contract v3).",
  },
  /**
   * §9.5 — did this lead become a live account.
   *
   * `probe: false`, and not because it writes. It requires `?email=`, and
   * every value the suite could send is either a real person's address —
   * making the nightly run a scheduled PII lookup — or a synthetic one that
   * exercises only the `state: "none"` branch and asserts nothing. Declared,
   * never called.
   *
   * `free` rather than a §4.1 envelope: the body is a bare
   * `{ state, ref?, label?, idle_hours?, observed_at }`, which is neither a
   * page nor a flat map of scalars.
   */
  conversions: {
    id: "conversions",
    method: "GET",
    path: "/admin/conversions",
    section: "9.5",
    envelope: "free",
    probe: false,
    summary: "Lead-to-account conversion state, by email; declared only, never invoked by the suite.",
  },
  "onboarding/funnel": {
    id: "onboarding/funnel",
    method: "GET",
    path: "/admin/onboarding/funnel",
    section: "9.6",
    envelope: "data-flat-map",
    summary: "Onboarding funnel counts as a flat map of scalars (contract v3).",
  },
  "onboarding/sessions": {
    id: "onboarding/sessions",
    method: "GET",
    path: "/admin/onboarding/sessions",
    section: "9.6",
    envelope: "data-pagination",
    summary: "Individual onboarding sessions behind the funnel (contract v3).",
  },
  /**
   * §9.7 — irreversible tenant erasure.
   *
   * `probe: false` for `tenant-lifecycle`'s reason, only stronger: suspending
   * a real tenant to check an envelope is worse than no check, and purging
   * one is unrecoverable. There is no sandbox tenant to point the suite at.
   *
   * `GET /admin/tenants/{id}/purge/preview` is deliberately NOT a separate
   * id. It is the read half of one operation and is meaningless without the
   * write; splitting them would let a product declare a preview it cannot
   * execute.
   */
  "tenant-purge": {
    id: "tenant-purge",
    method: "POST",
    path: "/admin/tenants/{id}/purge",
    section: "9.7",
    envelope: "free",
    probe: false,
    summary: "Irreversible tenant erasure; declared only, never invoked by the suite.",
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system/packages/admin-conformance
pnpm vitest run src/contract.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole package suite**

```bash
pnpm vitest run
```

Expected: PASS. `runner.test.ts` and `declaration.test.ts` iterate `ENDPOINT_IDS`; if either asserts a fixed count or a nine-item snapshot, update that assertion to the new set **in this task** — it is the same change, not a new one. Do not weaken an assertion to "at least nine" to make it pass; state the real list.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system
git add packages/admin-conformance/src/contract.ts packages/admin-conformance/src/contract.test.ts
git commit -m "feat(admin-conformance): add the seven contract v3 endpoint ids"
```

---

### Task 2: Declaration options for the new ids

**Files:**
- Modify: `design-system/packages/admin-conformance/src/declaration.ts:73-76` (`ENDPOINT_OPTION_KEYS`)
- Test: `design-system/packages/admin-conformance/src/declaration.test.ts` (append)

**Interfaces:**
- Consumes: `parseDeclaration` (already exported), `ENDPOINT_OPTION_KEYS` (module-private).
- Produces: no new exports. The behaviour it fixes: every v3 id accepts `true`/`{ implemented: true }` and **no** options.

None of the seven takes an option. `entities` needs `types` because §3.4's path is product-defined; `inbox` needs `slaKinds` because SLA reality is per queue kind. Nothing here has either property, and `ENDPOINT_OPTION_KEYS[id] ?? []` already yields "no options accepted" for an absent id. **So this task changes no production code** — it pins that absence with a test, so a later "just add an option" does not slip in unnoticed.

- [ ] **Step 1: Write the failing test**

Append to `src/declaration.test.ts`:

```ts
describe("contract v3 declarations", () => {
  const base = { slug: "mark8ly", contractVersion: 3 }

  it("accepts every v3 id declared as a bare true", () => {
    const declaration = parseDeclaration({
      ...base,
      endpoints: {
        outbox: true,
        "email-sends": true,
        notifications: true,
        "break-glass": true,
        conversions: true,
        "onboarding/funnel": true,
        "onboarding/sessions": true,
        "tenant-purge": true,
      },
    })
    expect(declaration.endpoints.outbox?.implemented).toBe(true)
    expect(declaration.endpoints["tenant-purge"]?.implemented).toBe(true)
  })

  it("rejects an option on a v3 id, naming that it accepts none", () => {
    expect(() =>
      parseDeclaration({ ...base, endpoints: { outbox: { types: ["a"] } } }),
    ).toThrow(/accepted options: none/)
  })

  it("still rejects an id the contract does not define", () => {
    expect(() =>
      parseDeclaration({ ...base, endpoints: { "onboarding/funnels": true } }),
    ).toThrow(/unknown endpoint/)
  })
})
```

Check the file's existing imports before adding — `parseDeclaration` and `describe/it/expect` are almost certainly imported already. Do not duplicate an import.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system/packages/admin-conformance
pnpm vitest run src/declaration.test.ts
```

Expected: on a correct Task 1 these **pass immediately**. That is the honest outcome, not a failure of the plan: `declaration.ts` is generic over `ENDPOINT_IDS`. If they pass, say so in the commit message and move on. If any fails, that is a real gap in Task 1 — fix `contract.ts`, not the test.

- [ ] **Step 3: Run the whole package suite**

```bash
pnpm vitest run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system
git add packages/admin-conformance/src/declaration.test.ts
git commit -m "test(admin-conformance): pin that contract v3 ids accept no declaration options"
```

---

### Task 3: Runner coverage for the two unprobed ids

**Files:**
- Test: `design-system/packages/admin-conformance/src/runner.test.ts` (append)

**Interfaces:**
- Consumes: `runConformance` (exported from `runner.ts`), whatever `fetchImpl` stub the existing tests in this file already use. **Read the top of `runner.test.ts` and reuse its stub** rather than writing a second one — a parallel harness in the same file is how two tests start disagreeing about what a response looks like.
- Produces: nothing exported.

- [ ] **Step 1: Write the failing test**

Append to `src/runner.test.ts`, adapting the client stub to the one already in the file:

```ts
describe("v3 endpoints that must never be called", () => {
  it("skips conversions and tenant-purge without issuing a request", async () => {
    const requested: string[] = []
    const findings = await runConformance({
      base: "https://example.test/api/v1/platform",
      secret: "s",
      declaration: {
        slug: "mark8ly",
        contractVersion: 3,
        endpoints: { conversions: { implemented: true }, "tenant-purge": { implemented: true } },
      },
      fetchImpl: async (input) => {
        requested.push(String(input))
        return new Response("{}", { status: 200 })
      },
    })

    // The point of probe:false is that no request happens. Asserting only on
    // the finding's status would pass even if the suite had purged a tenant
    // and then reported a skip.
    expect(requested.filter((url) => url.includes("/admin/conversions"))).toEqual([])
    expect(requested.filter((url) => url.includes("/purge"))).toEqual([])

    for (const id of ["conversions", "tenant-purge"]) {
      const finding = findings.find((f) => f.endpoint === id)
      expect(finding?.status).toBe("skip")
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/runner.test.ts
```

Expected: on a correct Task 1, PASS — `runner.ts:60` already short-circuits on `!isProbed(id)`. If a request *is* recorded, `probe: false` is missing from one of the two `ENDPOINTS` entries; fix `contract.ts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system
git add packages/admin-conformance/src/runner.test.ts
git commit -m "test(admin-conformance): assert the unprobed v3 ids issue no request"
```

---

### Task 4: Changeset, build, publish

**Files:**
- Create: `design-system/.changeset/<generated-name>.md`
- Verify: `design-system/packages/admin-conformance/dist/` builds

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `@tesserix/admin-conformance@0.8.0` on the **public npm registry** (registry.npmjs.org, via npm trusted publishing / OIDC — there is no `NPM_TOKEN`).

- [ ] **Step 1: Write the changeset**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system
pnpm changeset
```

Select `@tesserix/admin-conformance`, choose **minor**, and use this summary — the CHANGELOG is where a product owner finds out an id exists:

```
Contract v3: seven new endpoint ids

The vocabulary was closed at nine, and seven of mark8ly's mounted platform-admin reads structurally could not be declared — an unknown key throws and fails the entire run. That was one documented fact, not a design. It is now eight new ids across seven surfaces:

`outbox`, `email-sends`, `notifications`, `break-glass`, `onboarding/funnel`, `onboarding/sessions` are probed reads. `conversions` and `tenant-purge` are declared and deliberately never called — a run that purged a real tenant is unrecoverable, and one that looked a person up by email is a scheduled PII read.

Additive: no existing id changes shape, and a product that declares none of these is unaffected. `break-glass` requires the caller to pass `--capability rotate-credentials`; without it the endpoint answers 403, which is it working correctly.
```

- [ ] **Step 2: Build and verify the package**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system/packages/admin-conformance
pnpm build
pnpm vitest run
```

Expected: build succeeds, all tests pass. `packaging.test.ts` exists and asserts something about the built artifact — if it fails, it is telling you a real packaging problem; fix it rather than skipping it.

- [ ] **Step 3: Commit and open the PR**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/design-system
git add .changeset
git commit -m "chore(admin-conformance): changeset for contract v3"
git push -u origin HEAD
gh pr create --title "feat(admin-conformance): contract v3 endpoint ids" --body-file -
```

Run `gh pr create` as a **direct command**, never from inside a shell script — `gh` writes fail from `bash script.sh` in this estate with a misleading EMU error.

- [ ] **Step 4: Merge, and verify the publish actually happened**

```bash
npm view @tesserix/admin-conformance version
```

Expected: `0.8.0`. **This is a gate.** Do not start Task 5 until this prints 0.8.0 — a declaration naming a v3 id against a 0.7.0 suite fails the whole nightly run (design §9). Publishing is a *live-system state*, not the merge of the release PR; check the state, not the merge.

---

### Task 5: Amend the contract spec with §9

**Files:**
- Modify: `tesserix-home/docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md` — append a `## 9. v3 amendments (2026-08-29)` section before `## Changelog`, and add a changelog line.

**Interfaces:**
- Consumes: the design doc's §3 table and its §3.1-§3.3 rulings.
- Produces: the prose `contract.ts:1-11` names as the source of truth. `contract.ts`'s header says: *where this file and that document disagree, the document is right and this file is a bug.* Ship them in step or that sentence becomes false.

- [ ] **Step 1: Write §9**

Add one subsection per id — `§9.1 outbox` through `§9.7 tenant-purge` — with the section numbers already baked into Task 1's `ENDPOINTS` entries. Each must state: the method and path, the envelope required, whether the suite probes it and **why not** if it does not, and any capability required. Copy the reasoning from the design's §3.1-§3.3 rather than re-deriving it; three summaries of one ruling drift.

Then append to `## Changelog`:

```
- 2026-08-29 (v3): seven endpoint ids added — outbox, email-sends, notifications,
  break-glass, conversions, onboarding/funnel, onboarding/sessions, tenant-purge.
  Additive; no v2 id changed. conversions and tenant-purge are declarable but
  never probed. See §9.
```

- [ ] **Step 2: Verify the numbers agree**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new
grep -o 'section: "9\.[0-9]"' design-system/packages/admin-conformance/src/contract.ts | sort -u
grep -n '^### 9\.' tesserix-home/docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md
```

Expected: every `section:` value in `contract.ts` has a matching `### 9.x` heading. A section number pointing at nothing is the exact drift the header warns about.

- [ ] **Step 3: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md
git commit -m "docs(spec): contract v3 — seven new endpoint ids as §9"
```

---

### Task 6: Declare the seven ready ids in mark8ly, both copies

**Files:**
- Modify: `mark8ly/admin-conformance.json`
- Modify: `tesserix-k8s/charts/apps/mark8ly-marketplace-api-admin/templates/admin-conformance-configmap.yaml`
- Modify: `mark8ly/services/marketplace-api/internal/handlers/platformadmin/conformance_declaration_test.go:26-34` (`contractEndpointIDs`) and its `routeToContractID` map
- Test: the same Go file

**Interfaces:**
- Consumes: `@tesserix/admin-conformance@0.8.0`, verified published in Task 4.
- Produces: a mark8ly declaration at `contractVersion: 3` naming seven new ids.

**Which seven.** `break-glass` is **excluded** — it needs `--capability rotate-credentials` on the CronJob and a verified signing identity, which is V4 (design §9.1). Declaring it here ships a nightly failure. So seven of the eight ids are declared here: `outbox`, `email-sends`, `notifications`, `onboarding/funnel`, `onboarding/sessions` (probed, five) plus `conversions` and `tenant-purge` (declared, never called, two). Count them off the JSON in Step 3 rather than off this sentence.

- [ ] **Step 1: Write the failing Go test**

The Go guard mirrors `contract.ts` across a repo and a language boundary with nothing but a comment holding the link. Update its mirror first, so it fails until the JSON is declared.

In `conformance_declaration_test.go`, extend `contractEndpointIDs` to the full seventeen:

```go
var contractEndpointIDs = []string{
	"kpis",
	"inbox",
	"audit-logs",
	"entities",
	"health",
	"billing/subscriptions",
	"billing/trials",
	"tenant-lifecycle",
	"lifecycle/reason-codes",
	// contract v3 (design-system#…, 2026-08-29). Same rule as above: whoever
	// adds an eighteenth id to contract.ts updates this slice in the same
	// change, or this guard silently stops covering it.
	"outbox",
	"email-sends",
	"notifications",
	"break-glass",
	"conversions",
	"onboarding/funnel",
	"onboarding/sessions",
	"tenant-purge",
}
```

Then add each new route template to `routeToContractID`, built against the handlers' own `g.GET`/`g.POST` calls — not against a REST guess:

```go
	platformadmin.MountPrefix + "/admin/outbox":                 "outbox",
	platformadmin.MountPrefix + "/admin/email-sends":            "email-sends",
	platformadmin.MountPrefix + "/admin/notifications":          "notifications",
	platformadmin.MountPrefix + "/admin/break-glass":            "break-glass",
	platformadmin.MountPrefix + "/admin/conversions":            "conversions",
	platformadmin.MountPrefix + "/admin/onboarding/funnel":      "onboarding/funnel",
	platformadmin.MountPrefix + "/admin/onboarding/sessions":    "onboarding/sessions",
	platformadmin.MountPrefix + "/admin/tenants/:id/purge":      "tenant-purge",
```

Verify each key against the source before trusting this block:

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/mark8ly/services/marketplace-api/internal/handlers/platformadmin
grep -n 'g\.GET("/admin\|g\.POST("/admin' outbox.go email_sends.go notifications.go break_glass.go conversions.go onboarding.go tenant_purge.go
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/mark8ly/services/marketplace-api
go test ./internal/handlers/platformadmin/ -run TestConformanceDeclaration -v
```

Expected: FAIL, naming routes that are mounted but not declared in `admin-conformance.json`.

- [ ] **Step 3: Declare, in both copies**

`mark8ly/admin-conformance.json` in full:

```json
{
  "slug": "mark8ly",
  "contractVersion": 3,
  "endpoints": {
    "kpis": true,
    "inbox": {
      "slaKinds": [
        "sea_manual_review"
      ]
    },
    "audit-logs": true,
    "entities": {
      "types": [
        "tenants",
        "users"
      ]
    },
    "health": true,
    "billing/subscriptions": true,
    "billing/trials": true,
    "tenant-lifecycle": true,
    "lifecycle/reason-codes": true,
    "outbox": true,
    "email-sends": true,
    "notifications": true,
    "conversions": true,
    "onboarding/funnel": true,
    "onboarding/sessions": true,
    "tenant-purge": true
  }
}
```

Then apply the identical `endpoints` block to the ConfigMap template's embedded declaration. Read the template first — it embeds the JSON under a `data:` key with its own indentation; match it exactly rather than pasting.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/mark8ly/services/marketplace-api
go test ./internal/handlers/platformadmin/ -v
```

Expected: PASS, including the drift check between the two copies. `break-glass` is mounted and undeclared — if the guard fails *on that route specifically*, it is doing its job and V4 is where it gets declared; add it to an allowlist only if the test already has one for a deliberate gap, and record why in a comment. Do not declare `break-glass` to silence it.

- [ ] **Step 5: Commit both repos, separately**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/mark8ly
git add admin-conformance.json services/marketplace-api/internal/handlers/platformadmin/conformance_declaration_test.go
git commit -m "feat(platformadmin): declare the contract v3 endpoints"

cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
git add charts/apps/mark8ly-marketplace-api-admin/templates/admin-conformance-configmap.yaml
git commit -m "feat(mark8ly): declare the contract v3 endpoints in the conformance ConfigMap"
```

---

### Task 7: Prove it on the running system

**Files:** none. This task produces evidence, not a diff.

The milestone that preceded this one was closed on a conformance run, not on merged PRs — *"That is the proof this milestone is done, not an inference from merged PRs."* Hold this plan to the same standard.

- [ ] **Step 1: Run the suite against production on demand**

Do not wait for 06:20 UTC. Trigger the CronJob:

```bash
kubectl create job --from=cronjob/<mark8ly-conformance-cronjob-name> conformance-v3-check -n <namespace>
kubectl logs -f job/conformance-v3-check -n <namespace>
```

Get the exact CronJob and namespace from the chart rather than guessing:

```bash
grep -rn "name:\|namespace:" /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s/charts/apps/mark8ly-marketplace-api-admin/values.yaml | head
```

- [ ] **Step 2: Read the summary honestly**

Expected: exit 0, and a summary line naming **more** endpoints than the prior run's eleven. The pre-v3 baseline, from the milestone close on 2026-08-28, was:

```
Summary: 51 checks — 18 passed, 0 failed, 33 skipped across 11 endpoints
```

A run that reports 11 endpoints means the ConfigMap did not change or the suite resolved an older version — check `npm view @tesserix/admin-conformance version` and the ConfigMap actually mounted in the pod, in that order.

An endpoint reported as **failed** is a real deviation between mark8ly's handler and the envelope Task 1 declared. Per design §8, file it as an issue in mark8ly and fix the handler there — do not relax the `ENDPOINTS` entry to match a handler that is wrong. #415 corrected `/admin/inbox`'s envelope *before* declaring it, for this exact reason.

- [ ] **Step 3: Record the result**

Paste the summary line into the design doc under a new `## 10. Conformance at v3` heading, dated, alongside the 2026-08-28 baseline. That line is what lets V1-V8 start from a known-good foundation instead of an assumption.

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add docs/superpowers/specs/2026-08-29-admin-contract-v3-console-federation-design.md
git commit -m "docs(spec): record the contract v3 conformance run"
```

---

## What comes after this plan

Plan 0 is a gate, not a feature — nothing in the console changes. The eight verticals follow,
each its own plan, each producing working software on its own:

**V1 `outbox`** · **V2 `email-sends`** · **V3 `notifications`** · **V4 `break-glass`**
(also lands the CronJob's `--capability` flag and declares the id Task 6 held back) ·
**V5 `conversions`** · **V6 `onboarding`** · **V7 product `health`** (no contract change) ·
**V8 `tenant-purge`** (last, alone, destructive).

Each vertical is the same three layers: a platform-api module under
`internal/modules/<name>/` using `cfg.Federation.SlugsImplementing("<id>")`, a
`apps/console/lib/<name>.ts` reader, and a console page that clears the surface's
`pending: true` in `packages/console-core/src/routes.ts`. V1 is written first and in full;
V2-V8 are written against V1's merged shape rather than guessed at now.
