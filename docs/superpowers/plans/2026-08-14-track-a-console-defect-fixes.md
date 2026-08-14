# Track A — Console Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the defects found by the console audits that are worth fixing regardless of whether the console redesign proceeds.

**Architecture:** All changes are surgical fixes inside the existing `apps/web` app. No new packages, no new app, no architectural change. Each task is independent and independently revertable.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, SWR, `@tesserix/web`, `@tesserix/homechef-shared`, Vitest, Postgres migrations via `db/migrations/`.

**Spec:** `docs/superpowers/specs/2026-08-14-admin-console-redesign-design.md` (see its "Defects found during audit" section)

## Why this is a separate track

The redesign spec was reviewed and returned "do not proceed as written". These fixes were bundled into that spec's M0. They should not wait on it — several are money-affecting, and all of them are valuable whichever way the redesign goes.

**Deliberately NOT in this plan:** the `platform-shared` package extraction (786 LOC of mobile contracts). It is a refactor with a different risk profile and deserves its own plan. Same for the redesign itself.

## Global Constraints

- **No Go service changes.** Every fix is in `apps/web` or `db/migrations/`.
- **Commit messages:** conventional commits, single-line, no signature, no `Co-Authored-By`.
- **Do not modify** `app/api/admin/apps/homechef/gw/[...path]/route.ts` — the gateway's `data ?? null` passthrough is load-bearing (a documented production crash).
- Tests run with `pnpm --filter web test:unit` (Vitest). `vitest.config.ts` only discovers `lib/**/*.test.ts` and `app/**/*.test.ts` — **not** `components/`.
- Typecheck with `pnpm --filter web typecheck`.

---

### Task 1: P0 — Web cannot resolve 2 of 3 delivery-failure types

The gateway's `/delivery-failures` returns three collections. Web types the response as `{orderIssues}` only and posts to one resolve path. **Meal-plan-day and group-order delivery faults cannot be resolved from the web console at all — that money stays held in escrow.** Mobile resolves all three.

**Files:**
- Modify: `apps/web/app/admin/apps/homechef/support/page.tsx` (the `DeliveryFailureRow` interface and `DeliveryFailuresTab` component)
- Reference (do not modify): `apps/mobile/app/homechef/delivery-failures.tsx` — the working three-collection implementation
- Reference: `packages/homechef-shared/src/contracts.ts:463-503` — `OrderDeliveryFailure`, `DayDeliveryFailure`, `GroupDeliveryFailure`, `DeliveryFailuresResponse`

**Interfaces:**
- Consumes: `DeliveryFailuresResponse` from `@tesserix/homechef-shared` (already exported; currently unused by web)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Delete the local type and import the shared contract**

In `support/page.tsx`, delete the local `DeliveryFailureRow` interface entirely (it duplicates and narrows the shared contract). Add to the existing `@tesserix/homechef-shared` import:

```ts
import {
  type DeliveryFailuresResponse,
  type OrderDeliveryFailure,
  type DayDeliveryFailure,
  type GroupDeliveryFailure,
} from "@tesserix/homechef-shared";
```

- [ ] **Step 2: Widen the SWR type**

Replace the `useSWR` call in `DeliveryFailuresTab`:

```ts
const { data, isLoading, mutate } = useSWR<DeliveryFailuresResponse>(
  ["/delivery-failures", {}],
  swrFetcher,
  { refreshInterval: 30_000 },
);
```

- [ ] **Step 3: Generalise `resolveFault` to take an explicit path**

The three collections post to three different paths. Replace `resolveFault` with a path-taking version:

```ts
async function resolveFault(
  busyKey: string,
  path: string,
  fault: FaultClass,
  context: string,
) {
  const ok = await confirm({
    title: `Confirm ${fault} fault`,
    message: `${FAULT_OUTCOME[fault]} This cannot be undone. (${context})`,
    confirmLabel: `Confirm ${fault} fault`,
    tone: fault === "customer" ? "default" : "destructive",
  });
  if (!ok) return;
  setError(null);
  setBusyId(busyKey);
  try {
    await hcAdmin.post(path, { fault });
    await mutate();
  } catch (e) {
    setError(e instanceof Error ? e.message : "Resolve failed");
  } finally {
    setBusyId(null);
  }
}
```

- [ ] **Step 4: Read all three collections**

Replace `const rows = data?.orderIssues ?? [];` with:

```ts
const orderIssues: OrderDeliveryFailure[] = data?.orderIssues ?? [];
const mealPlanDays: DayDeliveryFailure[] = data?.mealPlanDays ?? [];
const groupOrders: GroupDeliveryFailure[] = data?.groupOrders ?? [];
const totalCount = orderIssues.length + mealPlanDays.length + groupOrders.length;
```

- [ ] **Step 5: Render the two missing sections**

Keep the existing order-issues table. Below it, add two sections using the same table markup pattern, wired to the correct paths. Meal-plan days key on `dayId`, group orders on `groupId`:

```tsx
{mealPlanDays.length > 0 ? (
  <section className="space-y-2">
    <h3 className="text-sm font-semibold text-foreground">Meal-plan days</h3>
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2">Plan</th>
            <th className="px-4 py-2">Date</th>
            <th className="px-4 py-2">Price</th>
            <th className="px-4 py-2">Hold</th>
            <th className="px-4 py-2">Fault</th>
          </tr>
        </thead>
        <tbody>
          {mealPlanDays.map((d) => (
            <tr key={d.dayId} className="border-t border-border">
              <td className="px-4 py-2">{d.mealPlanNumber}</td>
              <td className="px-4 py-2">{d.date}</td>
              <td className="px-4 py-2">{formatINR(d.price)}</td>
              <td className="px-4 py-2">
                <StatusBadge status={d.holdStatus} />
              </td>
              <td className="px-4 py-2">
                <div className="flex gap-1">
                  {(["customer", "platform", "chef"] as FaultClass[]).map((f) => (
                    <Button
                      key={f}
                      size="sm"
                      variant="outline"
                      disabled={busyId === d.dayId}
                      title={FAULT_OUTCOME[f]}
                      onClick={() =>
                        resolveFault(
                          d.dayId,
                          `/meal-plan-days/${d.dayId}/resolve-delivery-failure`,
                          f,
                          `plan ${d.mealPlanNumber}`,
                        )
                      }
                    >
                      {f}
                    </Button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
) : null}
```

Repeat the same structure for `groupOrders`, keyed on `g.groupId`, showing `g.subtotal`, `g.tax`, `g.holdStatus`, posting to `/group-orders/${g.groupId}/resolve-delivery-failure`, with context `` `group ${g.groupId.slice(0, 8)}` ``.

- [ ] **Step 6: Fix the empty state**

The tab must say "nothing waiting" only when all three are empty. Guard on `totalCount === 0`, not on the order-issues array.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS. If `formatINR` or `StatusBadge` are not already imported in this file, add them — `formatINR` from `@tesserix/homechef-shared`, `StatusBadge` from `@/components/admin/homechef/status-badge`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/apps/homechef/support/page.tsx
git commit -m "fix(web): resolve meal-plan-day and group-order delivery failures"
```

---

### Task 2: P1 — `[product]/audit-logs` ignores its own product parameter

The route validates `:product` then queries mark8ly's audit table unconditionally. Every product overview's "Critical events (24h)" tile shows **mark8ly's** count.

The correct fix is the one `onboarding/route.ts` already uses: hard-gate to the product it actually serves.

**Files:**
- Modify: `apps/web/app/api/admin/apps/[product]/audit-logs/route.ts`
- Create: `apps/web/app/api/admin/apps/[product]/audit-logs/route.test.ts`
- Reference: `apps/web/app/api/admin/apps/[product]/onboarding/route.ts` — the gating pattern to copy

**Interfaces:**
- Produces: a `404 {"error":"unsupported_product"}` for any product other than `mark8ly`. `components/admin/product-overview-layout.tsx` calls this via `useCriticalEventCount(config.id)` for every product and must degrade to no tile rather than erroring.

- [ ] **Step 1: Write the failing test**

Create `route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/mark8ly-audit", () => ({
  listAuditLogs: vi.fn(async () => []),
  getCriticalEventCount: vi.fn(async () => 0),
  getAuditFilterOptions: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/mark8ly", () => ({ mark8lyQuery: vi.fn(async () => ({ rows: [] })) }));

import { GET } from "./route";

function req() {
  return new Request("http://x/api/admin/apps/homechef/audit-logs") as never;
}

describe("[product]/audit-logs", () => {
  it("404s for homechef instead of returning mark8ly rows", async () => {
    const res = await GET(req(), { params: Promise.resolve({ product: "homechef" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unsupported_product" });
  });

  it("still serves mark8ly", async () => {
    const res = await GET(req(), { params: Promise.resolve({ product: "mark8ly" }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web test:unit -- audit-logs`
Expected: FAIL — the homechef case returns 200 with mark8ly rows.

- [ ] **Step 3: Add the gate**

In `route.ts`, replace the `getProductConfig(product)` try/catch block with:

```ts
  const { product } = await params;
  // This route reads mark8ly's platform_api audit_logs. It is NOT generic:
  // serving it for another product returned mark8ly's rows under that
  // product's URL, so every product overview showed mark8ly's critical-event
  // count. Gate hard, the same way onboarding/route.ts does.
  if (product !== "mark8ly") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }
```

Remove the now-unused `getProductConfig` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web test:unit -- audit-logs`
Expected: PASS (both cases).

- [ ] **Step 5: Verify the overview degrades rather than errors**

Read `components/admin/product-overview-layout.tsx` and `lib/admin/use-audit.ts`. Confirm a 404 from `useCriticalEventCount` renders no tile / a dash rather than throwing. If it throws, make the hook treat 404 as "not applicable" and return `null`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/admin/apps/\[product\]/audit-logs/
git commit -m "fix(web): gate product audit-logs route to mark8ly instead of serving its rows for every product"
```

---

### Task 3: Wallet balance adjustment has no confirmation

`adjust()` moves customer store credit with only `amount > 0` and a non-empty reason. Every peer money action uses the shared destructive confirm.

**Files:**
- Modify: `apps/web/app/admin/apps/homechef/wallets/page.tsx`

- [ ] **Step 1: Import the shared confirm hook**

```ts
import { useConfirm } from "@/components/admin/confirm-dialog";
```

and inside `WalletsInner`: `const { confirm } = useConfirm();`

- [ ] **Step 2: Gate the adjustment**

In `adjust()`, after the two validation guards and before `setSaving(true)`:

```ts
const ok = await confirm({
  title: type === "credit" ? "Credit this wallet?" : "Debit this wallet?",
  message: `${type === "credit" ? "Add" : "Remove"} ${formatINR(amt)} ${
    type === "credit" ? "to" : "from"
  } this customer's balance. This writes to the wallet ledger and cannot be undone.`,
  confirmLabel: type === "credit" ? "Credit wallet" : "Debit wallet",
  tone: "destructive",
});
if (!ok) return;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/admin/apps/homechef/wallets/page.tsx
git commit -m "fix(web): confirm before adjusting a customer wallet balance"
```

---

### Task 4: dwellm8 is invisible — seed its registry row and wire its KPI branch

dwellm8 is a deployed product (9 ArgoCD apps, 60+ schema files, a paise ledger with statutory reporting). Its console rail renders nothing: no `apps` registry row, and `[product]/kpis` has no dwellm8 branch so it falls through to `{}` and renders four em-dashes.

**Files:**
- Create: `apps/web/db/migrations/0016_seed_dwellm8_app.sql`
- Modify: `apps/web/db/seeds/apps.sql`
- Modify: `apps/web/app/api/admin/apps/[product]/kpis/route.ts`

**Interfaces:**
- Consumes: the `apps` table schema from migration `0012`
- Produces: an `apps` row with `slug = 'dwellm8'`, making the product visible to `/api/admin/apps`

- [ ] **Step 1: Confirm the dwellm8 cluster's real connection details**

Read `tesserix-k8s/charts/apps/dwellm8-postgres/values.yaml` and the ArgoCD app under `tesserix-k8s/argocd/prod/apps/dwellm8/`. Record the actual namespace, service name and database names. **Do not guess these** — the migration is idempotent and will be re-applied.

- [ ] **Step 2: Write the seed migration**

Create `0016_seed_dwellm8_app.sql` following `0015_seed_kora_app.sql` exactly — same `INSERT … ON CONFLICT (slug) DO UPDATE` shape, with a header comment explaining that dwellm8 was deployed long before it was registered, which is why its console rail rendered nothing. Set `db_admin_secret_name` to `NULL` (read-only, same rationale as Kora) and fill `db_namespace`, `db_host`, `db_port`, `db_databases`, `primary_domain`, `admin_url` from Step 1.

- [ ] **Step 3: Mirror into the seed file**

Add the same row to `db/seeds/apps.sql`. The 0015 header states these two must change together.

- [ ] **Step 4: Apply and verify**

Run: `pnpm --filter web db:migrate`
Then confirm the row exists and `/api/admin/apps` returns it.

- [ ] **Step 5: Replace the silent `{}` fallthrough with an explicit 501**

In `kpis/route.ts`, the `if (product !== "homechef") return NextResponse.json({})` fallthrough is why dwellm8 rendered dashes that read as zeroes. Change the unknown-product case to be explicit:

```ts
  if (product !== "homechef") {
    // An unknown product must not look like a product with zero activity.
    // Returning {} rendered four "—" tiles for dwellm8 for months and nobody
    // noticed it was unimplemented rather than idle.
    return NextResponse.json({ error: "not_instrumented" }, { status: 501 });
  }
```

Leave the homechef `catch` block returning `{}` — that path is a real degradation (API unreachable), not an unimplemented product, and its comment says so.

- [ ] **Step 6: Make the overview render "not instrumented" for a 501**

Read `components/admin/product-overview-layout.tsx` and `lib/admin/use-metrics.ts`. On a 501, the KPI grid must render an explicit "not instrumented yet" message instead of dash tiles. Add that branch.

- [ ] **Step 7: Update the kpis route test**

`app/api/admin/apps/[product]/kpis/route.test.ts` exists. Add a case asserting an unknown product returns 501, and update any existing case that asserted `{}`.

Run: `pnpm --filter web test:unit -- kpis`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/db/migrations/0016_seed_dwellm8_app.sql apps/web/db/seeds/apps.sql apps/web/app/api/admin/apps/\[product\]/kpis/
git commit -m "feat(web): register dwellm8 in the apps registry and return 501 for uninstrumented product KPIs"
```

---

### Task 5: Repoint ClickHouse at the live host

`clickhouse-otel.observability` was decommissioned 2026-07-26 and replaced by `clickhouse.observability`. The old host is pinned as a default in two places.

> **Note:** the observability data plane is currently parked at 0 pods. This fix makes the config correct; it does not make the page work. Do it anyway — a wrong hostname is a latent bug that will outlive the park.

**Files:**
- Modify: `apps/web/lib/db/clickhouse.ts:9-14`
- Modify: `tesserix-k8s/charts/apps/company/values.yaml` (the `CLICKHOUSE_OTEL_URL` entry, ~line 255)

- [ ] **Step 1: Update the default and the header comment**

In `clickhouse.ts`, change the fallback host to `clickhouse.observability.svc.cluster.local:8123` and update the first line of the header comment, which names the old host.

- [ ] **Step 2: Update the chart value**

Change `CLICKHOUSE_OTEL_URL` in the `company` chart to the same host. Confirm you are editing the built chart — `company` **is** registered in ArgoCD, so this ships.

- [ ] **Step 3: Commit (two repos)**

```bash
git add apps/web/lib/db/clickhouse.ts
git commit -m "fix(web): point ClickHouse client at the live observability host"
```

Then in `tesserix-k8s`:

```bash
git commit -am "fix(company): repoint CLICKHOUSE_OTEL_URL at clickhouse.observability"
```

---

### Task 6: Delete dead code

Three independent deletions, each verified before removal.

**Files:**
- Delete: `apps/web/lib/db/mark8ly-refunds.ts` (137 lines, zero callers)
- Modify: `apps/web/package.json` (remove nine `@tiptap/*` dependencies)

- [ ] **Step 1: Verify `mark8ly-refunds.ts` has no callers**

Run: `grep -rn "mark8ly-refunds\|listMark8lyRefunds\|toMinorUnits" apps/web apps/mobile --include=*.ts --include=*.tsx`
Expected: only the file's own definitions. If anything else appears, **stop and report** — do not delete.

- [ ] **Step 2: Delete it and typecheck**

Run: `rm apps/web/lib/db/mark8ly-refunds.ts && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 3: Verify TipTap has no importers**

Run: `grep -rn "@tiptap" apps/web/app apps/web/components apps/web/lib`
Expected: **no matches.** If any appear, stop — leave the deps in place and report.

- [ ] **Step 4: Remove the TipTap dependencies**

```bash
pnpm --filter web remove @tiptap/extension-highlight @tiptap/extension-image @tiptap/extension-link @tiptap/extension-placeholder @tiptap/extension-text-align @tiptap/extension-underline @tiptap/pm @tiptap/react @tiptap/starter-kit
```

- [ ] **Step 5: Verify the build still passes**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): drop unused TipTap dependencies and dead mark8ly-refunds module"
```

---

### Task 7: Un-orphan `delivery-intelligence`

The page is live and real (self-delivery pricing-engine cost dashboard) but has **zero inbound links** on web. Mobile links it from its Delivery screen. It is reachable only by typing the URL.

**Files:**
- Modify: `apps/web/app/admin/apps/homechef/delivery/page.tsx`
- Reference: `apps/mobile/app/homechef/delivery.tsx:51` — the equivalent mobile link

- [ ] **Step 1: Add the link**

In the `delivery` page header area, next to the Refresh control, add:

```tsx
<Link
  href="/admin/apps/homechef/delivery-intelligence"
  className="text-sm text-primary underline-offset-4 hover:underline"
>
  Delivery intelligence →
</Link>
```

Import `Link` from `next/link` if not already imported.

- [ ] **Step 2: Add a one-line note distinguishing the two pages**

They are unrelated systems that share a word — `/delivery` is 3PL couriers, `/delivery-intelligence` is the self-delivery pricing engine. Add a `title` attribute or adjacent muted text saying "self-delivery pricing engine costs" so nobody assumes it is more of the same.

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm --filter web typecheck
git add apps/web/app/admin/apps/homechef/delivery/page.tsx
git commit -m "fix(web): link delivery intelligence from the delivery page"
```

---

### Task 8: `platform-tickets` renders zeroed tiles over an empty table

The table is empty pending mark8ly's filing UI. The page has no empty-state branch, so it renders as though the data loaded and there is genuinely nothing wrong.

**Files:**
- Modify: `apps/web/app/admin/platform-tickets/page.tsx`

- [ ] **Step 1: Add an explicit empty state**

When `rows.length === 0` and not loading, render an `EmptyState` from `@tesserix/web` explaining that merchant ticket filing ships with mark8ly admin and this list populates then — rather than an empty `<tbody>` under zeroed KPI tiles.

- [ ] **Step 2: Suppress or annotate the KPI tiles when empty**

Four tiles reading `0` imply a healthy queue. Either hide them when the table is empty or label them "no data yet".

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm --filter web typecheck
git add apps/web/app/admin/platform-tickets/page.tsx
git commit -m "fix(web): add empty state to platform tickets instead of zeroed tiles"
```

---

### Task 9: `staff` hides everyone past the 50th

The page requests `limit: 50` and renders no pagination, while displaying `pagination.total` in its own subtitle. A 51st staff member is silently invisible.

**Files:**
- Modify: `apps/web/app/admin/apps/homechef/staff/page.tsx`

- [ ] **Step 1: Add page state and wire it to the SWR key**

```ts
const [page, setPage] = useState(1);
const { data, isLoading, mutate } = useSWR<Paginated<StaffMember>>(
  ["/staff", { page, limit: 50 }],
  swrFetcher,
);
```

- [ ] **Step 2: Add prev/next controls**

Below the table, mirroring the pagination markup already used in `app/admin/apps/homechef/audit-logs/page.tsx` (copy its structure so the two match). Disable Previous at `page === 1` and Next when `page * 50 >= data.pagination.total`.

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm --filter web typecheck
git add apps/web/app/admin/apps/homechef/staff/page.tsx
git commit -m "fix(web): paginate the staff list instead of silently capping at 50"
```

---

## Verification

After all tasks:

- [ ] `pnpm --filter web typecheck` — PASS
- [ ] `pnpm --filter web test:unit` — PASS
- [ ] `pnpm --filter web build` — PASS
- [ ] `pnpm --filter web lint` — PASS (`--max-warnings 0`)

Manual checks that automation cannot cover:

- [ ] Open `/admin/apps/homechef/support?tab=delivery` and confirm all three sections render, and that a meal-plan-day fault resolves without error.
- [ ] Open any non-mark8ly product overview and confirm the critical-events tile is absent or dashed, **not** showing mark8ly's number.
- [ ] Open `/admin/apps/dwellm8` and confirm it says "not instrumented" rather than showing four dashes.

## Out of scope — recorded, not done here

- `platform-shared` package extraction (786 LOC of mobile contracts) — own plan.
- The console redesign — see the spec's review outcome; do not start it from this plan.
- The seven infrastructure security issues (unauthenticated audit-log forgery, subscription-service `/admin` with no authorization, Redis `password: "password"`, etc.) — these are in other repos and need their own track.
- Unparking Prometheus — an operator decision, not a code change.
