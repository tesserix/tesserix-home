# Shared Entitlement Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the console a versioned, publishable record of what each plan entitles a tenant to, and prove it agrees with what mark8ly actually enforces.

**Architecture:** One `integer` per `(revision, source, plan, feature)` hanging off the existing `plan_catalog_revisions`, mirroring `plangate`'s single-value model. mark8ly exposes its compiled matrix over the existing `/admin/billing/*` federation; the console seeds from it and then parity-checks against it using the runner prices already use.

**Tech Stack:** Postgres (CloudNativePG), Next.js 16 / React 19 console, Go 1.26 (`platform-api` in this repo, `marketplace-api` in mark8ly), Gin, GORM.

**Spec:** `docs/superpowers/specs/2026-09-07-shared-entitlement-model-design.md`

## Global Constraints

- **Two repos.** Tasks 1, 3, 4, 5 are `tesserix-home`. **Task 2 is `mark8ly`** and merges separately; Task 3 cannot be verified end to end until Task 2 is deployed.
- **Migrations are manual and deploys are not.** Apply `0052` to production BEFORE merging Task 1. Use `node apps/web/scripts/db-migrate.mjs` — never pipe the `.sql` through `psql`, which writes the DDL without `schema_migrations` and makes #613's preflight refuse to start.
- **Never run tests from the primary checkout.** `pnpm --filter` there tests the primary checkout and goes green without executing worktree changes. Every command uses the worktree as cwd.
- **This repo is pnpm.** `npm ci` fails; there is no `package-lock.json`. `pnpm --filter @tesserix/console-core --filter @tesserix/platform-auth build` is required before `typecheck`.
- **Entitlement vocabulary, exact:** plans `trial`, `starter`, `studio`, `pro` (lower-case). FOUR, not three — `plangate`'s matrix keys on all four and a trial tenant is gated by its row. `marketplace` is excluded: it is absent from the matrix and resolves to all-Disabled by the fail-closed default, so there is nothing to mirror. Sentinels `0` disabled, `-1` unlimited, `-2` negotiated; positive integers are caps.
- **`0` is the zero value and means Disabled.** Nothing may make an absent entitlement permissive.
- **Migration style:** heavy header explaining WHY, `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` throughout, every CHECK named. Read `0051_promo_codes_scoping.sql` first.
- **No memory-style `[[wiki-links]]` in any committed file.** Write the idea out.

---

### Task 1: The entitlement table

**Files:**
- Create: `apps/web/db/migrations/0052_plan_catalog_entitlements.sql`
- Modify: `apps/console/lib/db/migration-idempotency.integration.test.ts`
- Test: `apps/console/lib/db/plan-catalog-entitlements.integration.test.ts`

**Interfaces:**
- Produces: table `plan_catalog_entitlements (revision_id uuid, source text, plan text, feature text, value integer)`, PK `(revision_id, source, plan, feature)`.

- [ ] **Step 1: Read the precedents before writing anything**

Read `apps/web/db/migrations/0051_promo_codes_scoping.sql` (header voice, named CHECKs, the `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair) and `0035_plan_catalog_revisions.sql` (how `revision_id` FKs are declared).

- [ ] **Step 2: Write the failing integration test**

Create `apps/console/lib/db/plan-catalog-entitlements.integration.test.ts`, following `promo-codes.integration.test.ts`'s PGlite setup exactly. Assert against Postgres, never a second hand-written expectation:

```ts
it("stores an entitlement and reads it back", async () => {
  await sql(`INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value)
    VALUES ($1,'mark8ly','pro','stores',-1)`, [revisionId]);
  const rows = await sql(`SELECT value FROM plan_catalog_entitlements
    WHERE revision_id=$1 AND plan='pro' AND feature='stores'`, [revisionId]);
  expect(rows[0].value).toBe(-1);
});

it.each([
  ["unknown plan",    `'mark8ly','enterprise','stores',1`, "plan_catalog_entitlements_plan_is_a_known_plan"],
  ["unknown feature", `'mark8ly','pro','teleport',1`,      "plan_catalog_entitlements_feature_is_a_known_feature"],
  ["unknown source",  `'kora','pro','stores',1`,           "plan_catalog_entitlements_source_is_a_known_source"],
  ["a fourth sentinel", `'mark8ly','pro','stores',-3`,     "plan_catalog_entitlements_value_is_a_known_sentinel_or_cap"],
])("refuses %s by name", async (_label, values, constraint) => {
  await expect(
    sql(`INSERT INTO plan_catalog_entitlements
      (revision_id, source, plan, feature, value) VALUES ($1,${values})`, [revisionId]),
  ).rejects.toThrow(constraint);
});

it("refuses a duplicate (revision, source, plan, feature)", async () => {
  const ins = `INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value) VALUES ($1,'mark8ly','pro','stores',1)`;
  await sql(ins, [revisionId]);
  await expect(sql(ins, [revisionId])).rejects.toThrow(/duplicate key|plan_catalog_entitlements_pkey/);
});

it("cascades when its revision is deleted", async () => {
  await sql(`INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value) VALUES ($1,'mark8ly','pro','stores',1)`, [revisionId]);
  await sql(`DELETE FROM plan_catalog_revisions WHERE id=$1`, [revisionId]);
  const rows = await sql(`SELECT 1 FROM plan_catalog_entitlements WHERE revision_id=$1`, [revisionId]);
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 3: Run it and verify it fails**

Run from `<worktree>/apps/console`:
`pnpm exec vitest run lib/db/plan-catalog-entitlements.integration.test.ts`
Expected: FAIL — `relation "plan_catalog_entitlements" does not exist`.

- [ ] **Step 4: Write the migration**

`apps/web/db/migrations/0052_plan_catalog_entitlements.sql`. The header must state, in `0051`'s voice: why entitlement and limit are ONE value and not two columns (`plangate` reads one int two ways via `IsAllowed`/`Limit`; two columns would be two things to keep agreeing); why `0` is both Disabled and the zero value (an unset cell fails closed — a partially-loaded entitlement set must never become permissive); why the feature vocabulary is CHECKed (a typo'd feature is an entitlement that silently applies to nothing and renders as set); why `value >= -2` (a fourth sentinel arriving silently would be read as a cap of -3 by every consumer); and the apply-before-merge warning.

```sql
CREATE TABLE IF NOT EXISTS plan_catalog_entitlements (
    revision_id uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE CASCADE,
    source text NOT NULL
           CONSTRAINT plan_catalog_entitlements_source_is_a_known_source
           CHECK (source IN ('mark8ly')),
    plan text NOT NULL
         CONSTRAINT plan_catalog_entitlements_plan_is_a_known_plan
         CHECK (plan IN ('trial', 'starter', 'studio', 'pro')),
    feature text NOT NULL
            CONSTRAINT plan_catalog_entitlements_feature_is_a_known_feature
            CHECK (feature IN (
                'stores', 'images_per_product', 'audit_retention_days',
                'campaign_emails_per_month', 'transactional_emails',
                'webhook_subscriptions', 'custom_domain', 'full_color_palette',
                'announcement_bar', 'remove_powered_by', 'custom_css',
                'custom_code_injection', 'white_label_app', 'csv_import_export',
                'shipping_labels', 'returns', 'reviews', 'tickets', 'gift_cards',
                'read_api', 'full_read_write_api', 'sso', 'uptime_sla',
                'standard_email_support', 'priority_email_support', 'named_csm')),
    value integer NOT NULL
          CONSTRAINT plan_catalog_entitlements_value_is_a_known_sentinel_or_cap
          CHECK (value >= -2),
    PRIMARY KEY (revision_id, source, plan, feature)
);
```

CASCADE and not RESTRICT, and the header says why: `plan_catalog_publications` uses RESTRICT because it guards an audit trail; this table holds no audit — an entitlement is meaningless without the revision it belongs to, which is `0038`'s reasoning for `operations -> attempt` and `0046`'s for the coupon table.

- [ ] **Step 5: Verify the feature list against plangate — do NOT trust the block above**

The 26 strings are transcribed from `mark8ly/services/marketplace-api/internal/plangate/matrix.go`. Verify every one against `origin/main` of mark8ly before committing:

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/mark8ly
git show origin/main:services/marketplace-api/internal/plangate/matrix.go \
  | grep -oE 'Feature = "[a-z_]+"' | sed 's/Feature = //' | tr -d '"' | sort
```

Compare against the CHECK list sorted. They must match exactly, and the count must be 26. A mismatch here is the whole task failing silently later. **Read mark8ly from `origin/main`, not the working tree — the sibling checkouts sit on feature branches.**

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/db/plan-catalog-entitlements.integration.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Add the 0052 case to the idempotency test**

Follow the `0051` case already in `apps/console/lib/db/migration-idempotency.integration.test.ts`. Then run it: `pnpm exec vitest run lib/db/migration-idempotency.integration.test.ts` — expected PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/db/migrations/0052_plan_catalog_entitlements.sql \
        apps/console/lib/db/plan-catalog-entitlements.integration.test.ts \
        apps/console/lib/db/migration-idempotency.integration.test.ts
git commit -m "feat(billing): a versioned entitlement per plan and feature (#146)"
```

---

### Task 2: mark8ly exposes its matrix (mark8ly repo)

**Files:**
- Create: `services/marketplace-api/internal/handlers/platformadmin/billing_entitlements.go`
- Create: `services/marketplace-api/internal/handlers/platformadmin/billing_entitlements_test.go`
- Modify: `services/marketplace-api/internal/handlers/platformadmin/routes.go` (mount the handler; add `Deps.CatalogMode`)
- Modify: `services/marketplace-api/cmd/marketplace-api/main.go` — **TWO `Deps{}` sites**, around lines 2455 and 2607. Wiring one and not the other leaves a binary path serving the wrong mode.
- Modify: `services/marketplace-api/internal/plangate/matrix.go` (+ its test) — **an exported `AllPlans()` is unavoidable.** `featureMatrix` is unexported and there is no other honest way to get its key set; a hard-coded four-name slice would break the derive rule at exactly the level this task is about. Membership must come from `featureMatrix`; a public plan enum may supply ORDER only.

**Interfaces:**
- Produces: `GET /admin/billing/entitlements` returning
  `{"source":"mark8ly","catalog_mode":"test","features":[...],"plans":{"trial":{...},"starter":{"stores":1,...},"studio":{...},"pro":{...}}}`

- [ ] **Step 1: Write the failing handler test**

```go
func TestEntitlementsHandlerReportsTheCompiledMatrix(t *testing.T) {
	h := NewBillingEntitlementsHandler("test", slog.Default())
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/admin/billing/entitlements", nil)

	h.list(c)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Source      string                    `json:"source"`
		CatalogMode string                    `json:"catalog_mode"`
		Features    []string                  `json:"features"`
		Plans       map[string]map[string]int `json:"plans"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))

	require.Equal(t, "mark8ly", body.Source)
	require.Equal(t, "test", body.CatalogMode)
	require.Len(t, body.Features, len(plangate.AllFeatures()))
	require.Len(t, body.Plans, 4)

	// DERIVED, never restated: assert against plangate itself, so a matrix
	// change moves this test rather than leaving it asserting a stale copy.
	for _, p := range []subscription.SubscriptionPlan{"trial", "starter", "studio", "pro"} {
		require.Equal(t, plangate.AllFeatureLimits(p), body.Plans[string(p)])
	}
}
```

- [ ] **Step 2: Run it and verify it fails**

Run from `services/marketplace-api`: `go test ./internal/handlers/platformadmin/ -run TestEntitlementsHandler -v`
Expected: FAIL to compile — `NewBillingEntitlementsHandler` undefined.

- [ ] **Step 3: Write the handler**

Mirror `billing_subscriptions.go`'s shape (`NewX...Handler`, `Register(g *gin.RouterGroup)`, a `list` method). The body must derive entirely from `plangate.AllFeatures()` and `plangate.AllFeatureLimits(plan)` — never restate a value. A comment must say so: restating would make this a third copy of the matrix, disagreeing with the gate it describes.

`catalogMode` is injected at construction from the same config value `CONSOLE_CATALOG_MODE` feeds, so the response is self-describing and the console never has to guess which mode this service reads.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/handlers/platformadmin/ -run TestEntitlementsHandler -v` — expected PASS.

- [ ] **Step 5: Register the route and verify the capability gate**

Register beside the other `/admin/billing/*` handlers. Then confirm the route needs no `packages/platformauth/middleware.go` entry: that file's comment says the set already serving in production (`/admin/billing/subscriptions`, `/admin/billing/trials`, …) has no entry and must keep none. Match whatever those do — do not invent a new gate.

Run the full package: `go test ./internal/handlers/platformadmin/` — expected PASS.

- [ ] **Step 6: Commit and open a PR in mark8ly**

```bash
git add services/marketplace-api/internal/handlers/platformadmin/billing_entitlements.go \
        services/marketplace-api/internal/handlers/platformadmin/billing_entitlements_test.go \
        services/marketplace-api/cmd/marketplace-api/main.go
git commit -m "feat(billing): expose the compiled plan-feature matrix for console parity (tesserix-home#146)"
```

**STOP after this task.** Task 3 can be written but cannot be verified end to end until this is merged AND deployed. Report that boundary rather than working around it.

---

### Task 3: platform-api federates the endpoint

**Files:**
- Modify: `platform-api/internal/modules/billing/internal/service/service.go` (add `entitlementsPath`, an `Entitlements` method)
- Modify: `platform-api/internal/modules/billing/internal/handler/handler.go` (route + handler method)
- Modify: `platform-api/internal/modules/billing/internal/domain/billing.go` (the response type)
- Test: `platform-api/internal/modules/billing/internal/handler/handler_test.go`

**Interfaces:**
- Consumes: Task 2's `GET /admin/billing/entitlements`.
- Produces: `GET /v1/billing/entitlements` — same envelope, capability gate and `ErrNotInstrumented` semantics as `/v1/billing/subscriptions`.

- [ ] **Step 1: Write the failing handler test**

Copy the shape of the existing `subscriptions` test in `handler_test.go`. Assert: a 200 carries `source`, `catalog_mode`, `features` and `plans`; a product that does not implement the endpoint yields `ErrNotInstrumented` rather than an empty payload — the existing comment on that error is explicit that an unconfigured estate must not render as a configured one with nothing in it, and that distinction has to survive here too.

- [ ] **Step 2: Run it and verify it fails**

Run from `platform-api`: `go test ./internal/modules/billing/... -run TestEntitlements -v`
Expected: FAIL to compile.

- [ ] **Step 3: Add the domain type, service method and route**

`entitlementsPath = "/admin/billing/entitlements"` beside the two existing constants. The service method follows `Subscriptions`' federation shape. The route goes in the same table as the others:

```go
{Method: http.MethodGet, Pattern: "/v1/billing/entitlements", Handler: h.entitlements, ...},
```

Use the same capability the sibling billing routes use — read it from the existing entries rather than choosing one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/modules/billing/...` — expected PASS.

- [ ] **Step 5: Run the whole platform-api suite**

Run: `go test ./...` from `platform-api`. Expected PASS. Note in your report whether database-backed tests actually ran — this suite silently SKIPS them unless `TESSERIX_TEST_DB_*` is exported, and "51 packages ok" with 41 tests skipped is not the same as green.

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/billing/
git commit -m "feat(billing): federate the plan-feature matrix from products (#146)"
```

---

### Task 4: Seed the console from the endpoint

**Files:**
- Modify: `apps/console/lib/db/plan-catalog-repo.ts` (write + read entitlements)
- Modify: `apps/console/lib/platform-api.ts` (`fetchProductEntitlements`)
- Create: `apps/console/app/(console)/platform/billing/catalog/entitlement-actions.ts` (the seeding server action)
- Test: `apps/console/lib/db/plan-catalog-entitlements.integration.test.ts` (extend), plus a test for the action

**CORRECTED 2026-09-08 — this is a server action, NOT a script.** The original
plan said `apps/console/scripts/seed-entitlements.ts` would fetch
`/v1/billing/entitlements`. **It cannot.** `resolvePlatformApiToken`
(`lib/auth/platform-token.ts`) is session-bound: it resolves the OPERATOR's
Zitadel token from their session and refresh token. A standalone script has no
session and no way to mint one — there is no machine credential for the
console -> platform-api direction. (mark8ly -> console has one,
`CONSOLE_CATALOG_CLIENT_ID`; the reverse does not exist.)

A server action is also what this codebase does anyway: console mutations are
server actions without exception, and a write that skipped one would skip the
audit trail every sibling write produces.

**Interfaces:**
- Consumes: Task 3's `/v1/billing/entitlements`; Task 1's table.
- Produces: `writeEntitlements(revisionId, source, rows)`, `readEntitlements(revisionId, source): Promise<EntitlementRow[]>` where `EntitlementRow = { plan: string; feature: string; value: number }`.

- [ ] **Step 1: Write the failing repository test**

```ts
it("writes a full matrix and reads it back", async () => {
  await writeEntitlements(revisionId, "mark8ly", [
    { plan: "pro", feature: "stores", value: -1 },
    { plan: "starter", feature: "sso", value: 0 },
  ]);
  const rows = await readEntitlements(revisionId, "mark8ly");
  expect(rows).toEqual(expect.arrayContaining([
    { plan: "pro", feature: "stores", value: -1 },
    { plan: "starter", feature: "sso", value: 0 },
  ]));
});

it("refuses a value below the sentinel floor rather than repairing it", async () => {
  await expect(
    writeEntitlements(revisionId, "mark8ly", [{ plan: "pro", feature: "stores", value: -3 }]),
  ).rejects.toThrow(/value_is_a_known_sentinel_or_cap/);
});
```

- [ ] **Step 2: Run and verify failure**

`pnpm exec vitest run lib/db/plan-catalog-entitlements.integration.test.ts` — FAIL, `writeEntitlements` is not exported.

- [ ] **Step 3: Implement the repository functions**

In `plan-catalog-repo.ts`, matching that file's existing conventions (parameterised queries, its narrowing helpers, its comment density). `writeEntitlements` inserts all rows in one statement. It must NOT silently skip or repair a rejected row — the DB constraint is the rule and the repository surfaces the violation, exactly as `promo-codes-repo.ts` throws rather than normalising.

- [ ] **Step 4: Run and verify pass**

`pnpm exec vitest run lib/db/plan-catalog-entitlements.integration.test.ts` — PASS.

- [ ] **Step 5: Add `fetchProductEntitlements` to `lib/platform-api.ts`**

Mirror `fetchEstateSubscriptions` exactly — same `platformRequest` call, same parse-then-return shape. It reads `GET /v1/billing/entitlements`. Keep the doc comment's habit of naming which capability a 403 means.

- [ ] **Step 6: Write the seeding server action**

`entitlement-actions.ts`, following `promo-actions.ts`'s shape — the same `withPromoWrite`-style audit wrapper the sibling actions use, `revalidatePath` after, and a `PromoActionResult`-shaped return.

It fetches the product's matrix, then writes every `(plan, feature, value)` onto the given revision. **Derived, never transcribed**, and it refuses rather than partially seeding: if the response carries fewer than 26 features or fewer than 4 plans, it returns an error and writes nothing. A partial seed would later compare as agreement on the rows that exist and be silent about the rows that do not, which is the failure this whole task exists to prevent.

No script, no bundling, no `build:*` entry — see the correction above.

- [ ] **Step 7: Run typecheck, lint and the console suite**

From `<worktree>/apps/console`: `pnpm typecheck && pnpm lint && pnpm exec vitest run`. All must pass. Report real counts.

- [ ] **Step 8: Commit**

```bash
git add apps/console/lib/db/plan-catalog-repo.ts \
        apps/console/lib/db/plan-catalog-entitlements.integration.test.ts \
        apps/console/lib/platform-api.ts \
        "apps/console/app/(console)/platform/billing/catalog/entitlement-actions.ts" \
        "apps/console/app/(console)/platform/billing/catalog/entitlement-actions.test.ts"
git commit -m "feat(billing): seed console entitlements from the enforcing matrix (#146)"
```

---

### Task 5: Parity between the console and the gate

**Files:**
- Create: `apps/console/lib/billing/entitlement-parity.ts`
- Create: `apps/console/lib/billing/entitlement-parity.test.ts`
- Modify: `apps/console/lib/billing/parity-run.ts` (record an entitlement run)

**Interfaces:**
- Consumes: Task 4's `readEntitlements`; Task 3's `/v1/billing/entitlements`.
- Produces: `compareEntitlements(consoleRows, productMatrix): EntitlementDifference[]` where `EntitlementDifference = { plan: string; feature: string; consoleValue: number | null; productValue: number | null }`.

- [ ] **Step 1: Write the failing comparator test**

Pure function, no database, no network — the same split `parity.ts` already keeps:

```ts
const matrix = { pro: { stores: -1, sso: 1 } };

it("reports no differences when both sides agree", () => {
  expect(compareEntitlements(
    [{ plan: "pro", feature: "stores", value: -1 }, { plan: "pro", feature: "sso", value: 1 }],
    matrix,
  )).toEqual([]);
});

it("reports a differing value with both sides named", () => {
  expect(compareEntitlements([{ plan: "pro", feature: "stores", value: 3 }, { plan: "pro", feature: "sso", value: 1 }], matrix))
    .toEqual([{ plan: "pro", feature: "stores", consoleValue: 3, productValue: -1 }]);
});

it("reports a feature the console lacks", () => {
  expect(compareEntitlements([{ plan: "pro", feature: "stores", value: -1 }], matrix))
    .toEqual([{ plan: "pro", feature: "sso", consoleValue: null, productValue: 1 }]);
});

it("reports a feature only the console has", () => {
  expect(compareEntitlements(
    [{ plan: "pro", feature: "stores", value: -1 }, { plan: "pro", feature: "sso", value: 1 },
     { plan: "pro", feature: "teleport", value: 1 }],
    matrix,
  )).toEqual([{ plan: "pro", feature: "teleport", consoleValue: 1, productValue: null }]);
});

// A MISSING entitlement must never read as agreement with a disabled one.
// 0 means Disabled AND is the zero value; if absence collapsed to 0 here, a
// console that failed to load its rows would report parity-clean against a
// matrix that disables everything.
it("does not treat an absent console row as a disabled one", () => {
  expect(compareEntitlements([], { pro: { sso: 0 } }))
    .toEqual([{ plan: "pro", feature: "sso", consoleValue: null, productValue: 0 }]);
});
```

- [ ] **Step 2: Run and verify failure**

`pnpm exec vitest run lib/billing/entitlement-parity.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement the comparator**

`entitlement-parity.ts`, pure, no `server-only` import (it must stay renderable without dragging `pg` into a bundle — `parity.ts` states that reasoning and this follows it). Compare the union of both key sets so a feature present on only one side is reported, never dropped.

- [ ] **Step 4: Run and verify pass**

`pnpm exec vitest run lib/billing/entitlement-parity.test.ts` — PASS, all five.

- [ ] **Step 5: Record the run against the mode the product reports**

Extend `parity-run.ts` to fetch `/v1/billing/entitlements`, read `catalog_mode` from the response, read the console entitlements for **that mode's live publication**, compare, and record via the existing `recordParityRun`. The mode written to `plan_catalog_parity_runs.mode` is the one the product reported — never a hard-coded `test`, and never a sentinel. A comment must state why: the console cannot see `CONSOLE_CATALOG_MODE`, the value moves at the Stripe live-key swap, and comparing the other mode's revision against a matrix nobody applies it to is permanent unactionable drift.

- [ ] **Step 6: Run typecheck, lint and the full console suite**

From `<worktree>/apps/console`: `pnpm typecheck && pnpm lint && pnpm exec vitest run`. Report real counts.

- [ ] **Step 7: Mutation-check the comparator**

Break one assertion deliberately (make `compareEntitlements` return `[]` unconditionally), confirm the tests fail, then restore **by file copy, not `git checkout`** — there is uncommitted work in this worktree and `git checkout` reverts to HEAD.

- [ ] **Step 8: Commit**

```bash
git add apps/console/lib/billing/entitlement-parity.ts \
        apps/console/lib/billing/entitlement-parity.test.ts \
        apps/console/lib/billing/parity-run.ts
git commit -m "feat(billing): parity between console entitlements and the enforcing matrix (#146)"
```

---

## Deliberately not in this plan

**Authoring.** The spec sequences it last, "once values are proven to match" — editing entitlements before parity exists means editing something nothing checks. It is a follow-up issue once Tasks 1-5 land.

**Counting dimensions, the module dependency graph, and multi-source.** Excluded by the spec with reasons; do not add them opportunistically.
