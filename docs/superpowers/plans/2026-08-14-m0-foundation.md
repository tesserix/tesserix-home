# M0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/console` with a shared IA package and a console kit, and prove both by moving Kora's eight surfaces onto them — ending with those routes deleted from `apps/web`.

**Architecture:** Two new packages (`console-core` for the IA and tokens, `platform-auth` for session/CSRF shared by both apps) and one new Next.js app. The kit is a thin layer over `@tesserix/web`, which already provides five of the nine primitives. Kora is the pilot because it has **no database access** — every read and write is an HMAC-signed API call — so the pilot needs one client file, not the whole data layer.

**Tech Stack:** Next.js 16 (App Router, Node runtime), React 19, TypeScript 5.9, `@tesserix/web` 1.8.1, SWR, Vitest, pnpm workspaces + Turbo.

**Spec:** `docs/superpowers/specs/2026-08-14-admin-console-redesign-design.md`
**Inventory (signed):** `docs/superpowers/specs/2026-08-14-surface-inventory-decisions.md`
**ADR:** `docs/ADR-002-DELIVERY-VISIBILITY.md`

## Scope: what M0 is and is not

**In:** `console-core`, `platform-auth`, the `apps/console` scaffold, four kit primitives plus two wrappers, Kora's eight surfaces ported, and the cutover that deletes them from `apps/web`.

**Deliberately deferred, with reasons:**

| Deferred | Why |
|---|---|
| **`platform-data` extraction** (`lib/db`, `lib/metrics`) | Kora needs none of it. Extracting a live data layer used by ~60 surfaces, to serve a pilot that does not read a database, is risk with no payoff. It lands when Inbox and Business need it (M1). |
| **Launchpad + registry schema + ArgoCD reconcile** | Its own vertical slice, and ADR-002 added scope to it (`argocd_app`, `kargo_project`, `kargo_stage`, `image_repo`). Separate plan. |
| **Inbox, Business, ⌘K** | M1. |

**Entry gate — M0 does not start until issue #112 is green:** Kora's CI must push to `ghcr.io/tesserix/kora/kora-api` (today it pushes to a different GCP project, so the image 404s), the `kargo-kora` project must exist, and `kora-postgres` must have backups. **A pilot whose purpose is proving the kit by shipping cannot ship otherwise.**

## Global Constraints

- **No Go service changes.** All work is in `apps/`, `packages/` and `db/migrations/`.
- **Commit messages:** conventional commits, SINGLE LINE, no signature, no `Co-Authored-By` trailer.
- **`console-core` contains zero renderer-specific code.** No `react-dom`, no `react-native`. Icons ship as **string keys**, never component references — web resolves through `lucide-react`, mobile through `lucide-react-native`.
- **Routes ship renderer-prefixed.** `console-core` owns route *identity*; each app owns its prefix (`/admin/...` on web, `/<product>/...` on mobile).
- **Display name and route identity are separate fields.** Fe3dr is one product with three names (repo `Home-Chef-App`, slug `homechef`, brand `fe3dr.com`).
- **Money is always minor units with an explicit currency.** Never a bare number.
- **Kit states are five, not four:** loading, empty, error, zero-results-after-filter, and **instrumentation unavailable** (the observability plane is parked — see #100).
- **Do not extend `@tesserix/web`'s `DataTable`.** It is 100% client-side with no `totalCount`/`onPageChange`/`onSortChange`/`loading`. Build alongside it.
- **Read a component's real API before using it.** Two briefs in the previous plan specified props that did not exist (`StatusBadge status=`, a props-based `EmptyState`). `LoadingState` does not exist at all — the real exports are `Skeleton`, `DataTableSkeleton`, `TableSkeleton` and friends.
- Verify with `pnpm --filter <pkg> typecheck`, `test:unit`, and `pnpm --filter console lint` (runs at `--max-warnings 0`).

## File structure

```
packages/console-core/          # renderer-free: IA, tokens, formatters
  src/
    tokens.ts                   # colour/space/radius/type as plain data
    icons.ts                    # IconKey union + the canonical key list
    nav.ts                      # NavItem/NavGroup/Section types + the tree
    routes.ts                   # route identity + renderer prefixing
    money.ts                    # Money type; bare numbers unrepresentable
    index.ts
packages/platform-auth/         # session + CSRF, shared by web and console
  src/
    session-jwt.ts              # moved from apps/web/lib/auth
    csrf.ts                     # moved from apps/web/lib/security
    bearer.ts
    config.ts
    index.ts
apps/console/
  middleware.ts                 # session gate, Node runtime
  app/
    layout.tsx                  # providers
    (console)/layout.tsx        # shell: sidebar from console-core nav
    (console)/kora/...          # the eight ported surfaces
  components/kit/
    console-data-table.tsx      # server-driven table
    filter-bar.tsx              # URL-serialised filters
    detail-layout.tsx
    queue-list.tsx
    page-header.tsx             # wraps @tesserix/web compound parts
    stat-tile.tsx               # wraps DashboardCard*
    states.tsx                  # the five states, incl. instrumentation-unavailable
  lib/
    kora-admin.ts               # moved from apps/web/lib/api
```

---

### Task 1: `packages/console-core` — IA as data

The mechanism that stops web/mobile drift. `apps/mobile` currently hand-copies ~200 lines of nav across four hub screens, and is already wrong: it omits `chef-rewards` and `tax-rates`, and still lists `delivery-failures`, which web deleted.

**Files:**
- Create: `packages/console-core/package.json`, `tsconfig.json`, `tsup.config.ts`
- Create: `packages/console-core/src/{icons,nav,routes,money,tokens,index}.ts`
- Create: `packages/console-core/src/{nav,routes,money}.test.ts`
- Reference (do not modify): `apps/web/lib/products/nav-config.ts` — the seed, already React-free and unit-tested
- Reference: `apps/web/app/globals.css:75-120` — the token values

**Interfaces — Produces:**
```ts
export type IconKey = "layout-dashboard" | "database" | "scroll-text"
  | "message-square" | "users" | "inbox" | "settings" | "activity";

export interface NavItem { name: string; route: RouteId; icon: IconKey }
export interface NavGroup { name: string; icon: IconKey; items: NavItem[] }
export type NavEntry = NavItem | NavGroup;
export function isNavGroup(e: NavEntry): e is NavGroup;

export type RouteId = keyof typeof ROUTES & string; // e.g. "kora.foods"
export function webPath(id: RouteId): string;       // "/admin/apps/kora/foods"
export function mobilePath(id: RouteId): string;    // "/kora/foods"
export function isRouteActive(currentPath: string, id: RouteId, prefix: "web" | "mobile"): boolean;

export interface Money { readonly minor: number; readonly currency: "INR" | "USD" }
export function money(minor: number, currency: Money["currency"]): Money;
export function formatMoney(m: Money): string;
```

- [ ] **Step 1: Scaffold the package**

Copy the shape of `packages/homechef-shared` exactly — same `package.json` fields (`main`/`module`/`types`/`exports`/`files`/`sideEffects`), same `tsconfig.json` extending `@tesserix/tsconfig/base.json`, same `tsup.config.ts`. Name it `@tesserix/console-core`, version `0.0.0`, private.

Add to `apps/web/package.json` dependencies later (Task 5), not now.

- [ ] **Step 2: Write the failing route-identity test**

`packages/console-core/src/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { webPath, mobilePath, isRouteActive } from "./routes";

describe("route identity", () => {
  it("prefixes the same id differently per renderer", () => {
    expect(webPath("kora.foods")).toBe("/admin/apps/kora/foods");
    expect(mobilePath("kora.foods")).toBe("/kora/foods");
  });

  it("treats a product root as exact, not prefix", () => {
    // Regression: "/admin/apps/kora" is a strict prefix of every nested Kora
    // route, so a startsWith match kept Overview highlighted everywhere.
    expect(isRouteActive("/admin/apps/kora/foods", "kora.overview", "web")).toBe(false);
    expect(isRouteActive("/admin/apps/kora", "kora.overview", "web")).toBe(true);
  });

  it("matches nested routes by prefix", () => {
    expect(isRouteActive("/admin/apps/kora/foods/abc", "kora.foods", "web")).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @tesserix/console-core test:unit`
Expected: FAIL — `routes.ts` does not exist.

- [ ] **Step 4: Implement `routes.ts`**

```ts
// Route identity lives here, not in either app. This is what prevents the
// mediation/messaging and audit-log/audit-logs drift between web and mobile.
const ROUTES: Record<string, { web: string; mobile: string; exact?: boolean }> = {
  "kora.overview": { web: "/admin/apps/kora",          mobile: "/kora",          exact: true },
  "kora.foods":    { web: "/admin/apps/kora/foods",    mobile: "/kora/foods" },
  "kora.audit":    { web: "/admin/apps/kora/audit",    mobile: "/kora/audit" },
  "kora.feedback": { web: "/admin/apps/kora/feedback", mobile: "/kora/feedback" },
  "kora.users":    { web: "/admin/apps/kora/users",    mobile: "/kora/users" },
};

export type RouteId = keyof typeof ROUTES & string;

export function webPath(id: RouteId): string { return ROUTES[id].web; }
export function mobilePath(id: RouteId): string { return ROUTES[id].mobile; }

export function isRouteActive(currentPath: string, id: RouteId, prefix: "web" | "mobile"): boolean {
  const entry = ROUTES[id];
  const target = prefix === "web" ? entry.web : entry.mobile;
  // Product roots are a strict prefix of their own children, so an exact
  // match is required or Overview stays highlighted on every nested route.
  if (entry.exact) return currentPath === target || currentPath === `${target}/`;
  return currentPath.startsWith(target);
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm --filter @tesserix/console-core test:unit`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the money test**

`packages/console-core/src/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { money, formatMoney } from "./money";

describe("money", () => {
  it("formats INR minor units as rupees", () => {
    expect(formatMoney(money(98420, "INR"))).toBe("₹984.20");
  });

  it("formats USD minor units as dollars", () => {
    expect(formatMoney(money(1500, "USD"))).toBe("$15.00");
  });

  it("rejects non-integer minor units", () => {
    // Guards the live footgun: HomeChef's payout amounts are float64 on the
    // wire, and three console pages disagreed about paise vs rupees.
    expect(() => money(12.5, "INR")).toThrow();
  });
});
```

- [ ] **Step 7: Run it, watch it fail, implement `money.ts`**

Run: `pnpm --filter @tesserix/console-core test:unit` → FAIL.

```ts
export interface Money { readonly minor: number; readonly currency: "INR" | "USD" }

const SYMBOL: Record<Money["currency"], string> = { INR: "₹", USD: "$" };
const EXPONENT: Record<Money["currency"], number> = { INR: 2, USD: 2 };

export function money(minor: number, currency: Money["currency"]): Money {
  if (!Number.isInteger(minor)) {
    throw new Error(`money() requires integer minor units, got ${minor}`);
  }
  return { minor, currency };
}

export function formatMoney(m: Money): string {
  const div = 10 ** EXPONENT[m.currency];
  return `${SYMBOL[m.currency]}${(m.minor / div).toFixed(EXPONENT[m.currency])}`;
}
```

Run again: PASS.

- [ ] **Step 8: Add `icons.ts`, `nav.ts` and `tokens.ts`**

`icons.ts` exports the `IconKey` union above and nothing else — no imports. `nav.ts` defines `NavItem`/`NavGroup`/`NavEntry`/`isNavGroup` and exports `koraNav: NavEntry[]` using `RouteId` and `IconKey` values only. `tokens.ts` exports the palette from `globals.css:75-120` as a plain object (`background: "#f5f7fa"`, `foreground: "#0b0e14"`, …) plus a numeric `space` scale and a `radius` ladder.

Write a nav test asserting every `NavItem.route` resolves through `webPath` without throwing — that is what catches a nav entry pointing at a nonexistent route.

- [ ] **Step 9: Typecheck, build, commit**

```bash
pnpm --filter @tesserix/console-core typecheck
pnpm --filter @tesserix/console-core build
git add packages/console-core
git commit -m "feat(console-core): add renderer-free IA, route identity, money and tokens"
```

---

### Task 2: `packages/platform-auth` — session and CSRF shared by both apps

`apps/console` needs the same session verification `apps/web` uses. Copying it would create exactly the drift this project exists to eliminate.

**Files:**
- Create: `packages/platform-auth/{package.json,tsconfig.json,tsup.config.ts}`
- Move: `apps/web/lib/auth/{session-jwt.ts,bearer.ts,config.ts}` → `packages/platform-auth/src/`
- Move: `apps/web/lib/security/csrf.ts` → `packages/platform-auth/src/csrf.ts`
- Move: the matching `*.test.ts` files alongside them
- Modify: every `apps/web` import of those modules
- Modify: `apps/web/package.json` (add the dependency)

**Interfaces — Produces:** re-exports `SessionClaims`, `signSession`, `verifySession`, `getCurrentSession`, `sessionCookieName`, `sessionCookieOptions`, `SessionCookieOptions`, `bearerToken`, `evaluateCsrf`, `CsrfDecision`, `CsrfRequest`.

- [ ] **Step 1: Scaffold, mirroring `homechef-shared`**

Same shape as Task 1 Step 1. Name `@tesserix/platform-auth`.

- [ ] **Step 2: Move the files with `git mv` so history follows**

```bash
mkdir -p packages/platform-auth/src
git mv apps/web/lib/auth/session-jwt.ts packages/platform-auth/src/
git mv apps/web/lib/auth/session-jwt.test.ts packages/platform-auth/src/
git mv apps/web/lib/auth/bearer.ts packages/platform-auth/src/
git mv apps/web/lib/auth/bearer.test.ts packages/platform-auth/src/
git mv apps/web/lib/auth/config.ts packages/platform-auth/src/
git mv apps/web/lib/security/csrf.ts packages/platform-auth/src/
git mv apps/web/lib/security/csrf.test.ts packages/platform-auth/src/
```

Do **not** move `oauth.ts`, `auth-client.ts` or `auth-context.tsx` — those are web-app-specific (React context, OAuth redirect handling) and stay put.

- [ ] **Step 3: Write `src/index.ts` re-exporting all of it, and fix intra-package imports**

Inside the moved files, `@/lib/...` path aliases will not resolve. Rewrite them as relative imports (`./config`, `./bearer`). Nothing in this package may import `@/` — it has no Next.js alias.

- [ ] **Step 4: Update every consumer in `apps/web`**

```bash
grep -rln "@/lib/auth/session-jwt\|@/lib/auth/bearer\|@/lib/auth/config\|@/lib/security/csrf" apps/web
```

Replace each with `@tesserix/platform-auth`. Add `"@tesserix/platform-auth": "workspace:*"` to `apps/web/package.json`, then `pnpm install`.

- [ ] **Step 5: Verify nothing regressed**

```bash
pnpm --filter @tesserix/platform-auth test:unit   # the moved tests must pass here now
pnpm --filter web typecheck
pnpm --filter web test:unit                        # 189 tests, minus the moved ones
pnpm --filter web build
```

If `web`'s test count dropped by exactly the number of moved test files and `platform-auth` gained them, the move is clean. Report both numbers.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract session and csrf into @tesserix/platform-auth"
```

---

### Task 3: `apps/console` scaffold

An empty-but-real console that authenticates and renders the nav from `console-core`.

**Files:**
- Create: `apps/console/{package.json,tsconfig.json,next.config.ts,middleware.ts,postcss.config.mjs,eslint.config.mjs,vitest.config.ts}`
- Create: `apps/console/app/{layout.tsx,globals.css}`, `apps/console/app/(console)/layout.tsx`
- Create: `apps/console/components/nav/{sidebar.tsx,icon.tsx}`
- Reference: `apps/web/{next.config.ts,middleware.ts,tsconfig.json,vitest.config.ts}` — copy their shape

**Interfaces — Consumes:** `@tesserix/console-core` (nav, routes, tokens, icons), `@tesserix/platform-auth` (`verifySession`, `sessionCookieName`, `evaluateCsrf`, `bearerToken`).
**Produces:** `apps/console` dev server on port **3003** (3002 is `web`).

- [ ] **Step 1: Scaffold the app**

`package.json` named `console`, private, scripts mirroring `apps/web`'s but with `next dev -p 3003`. Dependencies: `next`, `react`, `react-dom`, `@tesserix/web`, `@tesserix/console-core`, `@tesserix/platform-auth`, `swr`, `lucide-react`, `tailwindcss`, `clsx`. **Do not** copy TipTap, Recharts, `@tesserix/otto-widget` or `@google-cloud/*` — none is needed yet.

`next.config.ts`: copy `apps/web`'s `output: 'standalone'` and `outputFileTracingRoot: path.join(import.meta.dirname, "../../")`. Omit its `redirects()` and `transpilePackages` for now.

`tsconfig.json`: copy `apps/web`'s verbatim, including `"paths": { "@/*": ["./*"] }`.

- [ ] **Step 2: Port the middleware**

Copy `apps/web/middleware.ts` and adapt:
- Keep `export const config = { runtime: "nodejs", matcher: [...] }` — jose's symmetric crypto needs the Node runtime, and Edge forces wasm fallbacks.
- Keep the production assertion that throws if `NEXT_PUBLIC_DEV_AUTH_BYPASS === "true"`.
- **Replace `PUBLIC_PATHS` with an empty list.** The console has no public pages — that is the point of splitting it from marketing.
- Import from `@tesserix/platform-auth`, not `@/lib/...`.

- [ ] **Step 3: Write the icon resolver**

`components/nav/icon.tsx` — this is where `IconKey` becomes a component, and it is the only place `lucide-react` is imported for nav:

```tsx
import {
  Activity, Database, Inbox, LayoutDashboard, MessageSquare,
  ScrollText, Settings, Users,
} from "lucide-react";
import type { IconKey } from "@tesserix/console-core";

const REGISTRY: Record<IconKey, React.ComponentType<{ className?: string }>> = {
  "activity": Activity,
  "database": Database,
  "inbox": Inbox,
  "layout-dashboard": LayoutDashboard,
  "message-square": MessageSquare,
  "scroll-text": ScrollText,
  "settings": Settings,
  "users": Users,
};

export function NavIcon({ name, className }: { name: IconKey; className?: string }) {
  const Cmp = REGISTRY[name];
  return <Cmp className={className} aria-hidden="true" />;
}
```

The `Record<IconKey, …>` type is load-bearing: adding an `IconKey` in `console-core` without adding it here is a compile error, not a blank icon at runtime.

- [ ] **Step 4: Build the shell**

`app/(console)/layout.tsx` renders `components/nav/sidebar.tsx`, which maps `koraNav` through `webPath` and `isRouteActive` from `console-core` and `NavIcon` for the glyphs. Copy the visual treatment from `apps/web/components/admin/sidebar.tsx` but **not its structure** — no rail, no `getActiveContext`, no `getSecondaryNav`.

`app/globals.css` imports Tailwind and defines the same `:root` custom properties as `apps/web/app/globals.css:75-120`, sourced from `console-core`'s `tokens.ts` values so they cannot drift.

- [ ] **Step 5: Verify it boots and gates**

```bash
pnpm --filter console typecheck
pnpm --filter console build
pnpm --filter console dev    # then: curl -si localhost:3003/ | head -1
```
Expected: a redirect to login (no session), **not** a 200. Confirm that in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/console
git commit -m "feat(console): scaffold apps/console with session gate and console-core nav"
```

---

### Task 4: The console kit

Four primitives to build, two to wrap. **`@tesserix/web` already provides `EmptyState`, `ErrorState` and the skeletons** — reuse them; do not reimplement.

**Files:**
- Create: `apps/console/components/kit/{console-data-table,filter-bar,detail-layout,queue-list,page-header,stat-tile,states}.tsx`
- Create: `apps/console/components/kit/{filter-bar,states}.test.ts`

**Interfaces — Produces:**
```ts
export interface Column<T> { key: string; header: string; sortable?: boolean; cell: (row: T) => React.ReactNode }
export interface ConsoleDataTableProps<T> {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
  total: number; page: number; pageSize: number;
  onPageChange(page: number): void;
  sort?: { key: string; dir: "asc" | "desc" };
  onSortChange?(s: { key: string; dir: "asc" | "desc" }): void;
  state: SurfaceState; emptyMessage: string;
  selection?: { selected: Set<string>; onChange(s: Set<string>): void };
  bulkActions?: { id: string; label: string; destructive?: boolean; run(ids: string[]): Promise<void> }[];
}
export type SurfaceState =
  | { kind: "ready" } | { kind: "loading" } | { kind: "empty" }
  | { kind: "filtered-empty" } | { kind: "error"; message: string }
  | { kind: "instrumentation-unavailable" };

export interface FilterDescriptor { key: string; label: string; type: "select" | "search"; options?: { value: string; label: string }[] }
export function useUrlFilters(descriptors: FilterDescriptor[]): {
  values: Record<string, string>; set(key: string, value: string): void; clear(): void;
};
```

- [ ] **Step 1: Write the failing filter test**

Filters must serialise to the URL — saved views depend on it, and it fixes the dead deep links (`?chefId=`, `?search=`) that three pages currently ignore.

`components/kit/filter-bar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filtersToQuery, queryToFilters } from "./filter-bar";

const DESCRIPTORS = [
  { key: "status", label: "Status", type: "select" as const,
    options: [{ value: "open", label: "Open" }] },
  { key: "q", label: "Search", type: "search" as const },
];

describe("filter serialisation", () => {
  it("round-trips through a query string", () => {
    const q = filtersToQuery({ status: "open", q: "sunita" });
    expect(queryToFilters(new URLSearchParams(q), DESCRIPTORS))
      .toEqual({ status: "open", q: "sunita" });
  });

  it("drops empty values so the URL stays clean", () => {
    expect(filtersToQuery({ status: "", q: "x" })).toBe("q=x");
  });

  it("ignores query params not in the descriptor list", () => {
    expect(queryToFilters(new URLSearchParams("status=open&evil=1"), DESCRIPTORS))
      .toEqual({ status: "open" });
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement `filter-bar.tsx`**

Run: `pnpm --filter console test:unit` → FAIL.

Implement `filtersToQuery`, `queryToFilters` and `useUrlFilters` (which reads `useSearchParams` and pushes with `router.replace`), then the `FilterBar` component rendering a search input and a pill group per descriptor. Run again: PASS.

- [ ] **Step 3: Write the state test**

`components/kit/states.test.ts` asserts `resolveState` picks the right `SurfaceState` — this is the logic that keeps a parked data plane from looking healthy:

```ts
import { describe, expect, it } from "vitest";
import { resolveState } from "./states";

describe("resolveState", () => {
  it("reports instrumentation-unavailable for a 501, not an error", () => {
    expect(resolveState({ isLoading: false, error: { status: 501 }, rows: [], filtered: false }))
      .toEqual({ kind: "instrumentation-unavailable" });
  });

  it("reports a transient failure as an error, not as uninstrumented", () => {
    // A network blip must never claim the product is uninstrumented.
    expect(resolveState({ isLoading: false, error: { status: 500, message: "boom" }, rows: [], filtered: false }))
      .toEqual({ kind: "error", message: "boom" });
  });

  it("distinguishes empty from filtered-empty", () => {
    expect(resolveState({ isLoading: false, error: null, rows: [], filtered: false })).toEqual({ kind: "empty" });
    expect(resolveState({ isLoading: false, error: null, rows: [], filtered: true })).toEqual({ kind: "filtered-empty" });
  });
});
```

- [ ] **Step 4: Implement `states.tsx`**

`resolveState` per the test. The renderer maps each kind onto `@tesserix/web`'s components — **read their real APIs first**: `EmptyState` is compound (`EmptyState` / `EmptyStateIcon` / `EmptyStateTitle` / `EmptyStateDescription` / `EmptyStateActions`), `ErrorState` takes `type`/`code`/`details`/`onRetry`, and the loading skeletons are `Skeleton`, `DataTableSkeleton`, `TableSkeleton` — **there is no `LoadingState` component**.

`instrumentation-unavailable` renders its own message: *"Instrumentation is unavailable — the observability data plane is parked. See docs/observability-park.md."* It must be visually distinct from both empty and error.

Run: `pnpm --filter console test:unit` → PASS.

- [ ] **Step 5: Build `ConsoleDataTable`**

Compose `@tesserix/web`'s `Table*` primitives + `Pagination` + the states from Step 4. Server-driven: it never sorts or paginates in memory, it calls `onPageChange`/`onSortChange`. Selection and bulk actions are optional props; when `bulkActions` is present and `selected.size > 0`, render an action bar above the table.

- [ ] **Step 6: Build `DetailLayout` and `QueueList`, wrap `PageHeader` and `StatTile`**

`DetailLayout`: two-column — summary rail plus tabbed body, modelled on `apps/web/components/admin/tenant-detail-layout.tsx` (326 lines, the best existing example).

`QueueList`: rows of `{ key, title, subtitle, product, waitingSince, dueAt?, severity, href, actions }`. **`key` is an opaque string, not a UUID** — real queues are keyed compositely (`(aggType, id)`, `(run_id, gate_name)`). Render relative wait time and, where `dueAt` is present, an SLA indicator.

`PageHeader` wraps `@tesserix/web`'s compound parts behind `{ title, description, breadcrumbs, actions }`. `StatTile` wraps `DashboardCard*` behind `{ label, value, delta, trend, loading, href }`.

- [ ] **Step 7: Add the lint rule banning raw tables**

In `apps/console/eslint.config.mjs`, add a `no-restricted-syntax` rule rejecting `JSXOpeningElement[name.name='table']` outside `components/kit/`, with the message: *"Use ConsoleDataTable. 40 files in the old console hand-rolled a table; that is the duplication this kit exists to end."*

- [ ] **Step 8: Verify and commit**

```bash
pnpm --filter console typecheck && pnpm --filter console test:unit && pnpm --filter console lint
git add apps/console
git commit -m "feat(console): add the console kit primitives and five surface states"
```

---

### Task 5: Port Kora onto the kit

Kora's eight surfaces move to `apps/console` and are rebuilt on the primitives. **This is the task that proves the kit is shared rather than resembled** — none of Kora's current pages instantiates a shared component.

**Files:**
- Move: `apps/web/lib/api/kora-admin.ts` (+ its test) → `apps/console/lib/kora-admin.ts`
- Create: `apps/console/app/(console)/kora/{page.tsx,foods/page.tsx,foods/[id]/page.tsx,foods/new/page.tsx,audit/page.tsx,feedback/page.tsx,users/page.tsx,users/[id]/page.tsx}`
- Move: the six Kora `*.test.ts` files from `apps/web/app/admin/apps/kora/` into the matching console paths
- Reference (do not modify yet): `apps/web/app/admin/apps/kora/**` — the source of behaviour

**Interfaces — Consumes:** every kit primitive from Task 4; `koraNav`/`webPath` from Task 1; `kora-admin.ts`'s existing client.

- [ ] **Step 1: Move the client and its tests, and confirm they still pass**

`kora-admin.ts` is 874 lines with HMAC signing, runtime response validation and typed error propagation. It is the best-engineered client in the console — move it, do not rewrite it.

```bash
git mv apps/web/lib/api/kora-admin.ts apps/console/lib/
git mv apps/web/lib/api/kora-admin.test.ts apps/console/lib/
pnpm --filter console test:unit
```

Fix `@/lib/...` imports inside it to `@/lib/kora-admin`'s new neighbours. Its `logger` import needs a console-local equivalent — create `apps/console/lib/logger.ts` mirroring `apps/web/lib/logger.ts`.

- [ ] **Step 2: Port the six existing Kora tests first**

They are the regression harness and the reason Kora was chosen as pilot. Move them, point them at the new page paths, and run them **before** writing any page. They will fail — that is the RED state for this whole task.

Run: `pnpm --filter console test:unit`
Expected: FAIL — the pages do not exist yet.

- [ ] **Step 3: Port `foods` — the list surface**

Rebuild `apps/web/app/admin/apps/kora/foods/page.tsx` (234 lines) on `ConsoleDataTable` + `FilterBar` + `PageHeader`. Behaviour to preserve exactly: search filter, 50-per-page pagination, and the **past-end-of-range** state (a stale offset beyond the last page) which the original handles as a distinct case from empty. Map it to `SurfaceState` `{ kind: "filtered-empty" }`.

Add Suspense with `DataTableSkeleton` — the current server-rendered pages have **no loading UI at all**.

- [ ] **Step 4: Port `foods/[id]`, `foods/new` and the food form**

`DetailLayout` for the detail page, with the embedded scoped audit table as a tab. The form keeps its `useActionState`/`useFormStatus` shape and its optimistic-concurrency handling — a 409 `stale_update` must still surface as a conflict message, and a duplicate-barcode 409 must stay distinguishable from it.

- [ ] **Step 5: Port `audit` and `users`**

`audit` on `ConsoleDataTable` with its target-id filter (deep-linked from food detail) via `useUrlFilters`. `users` list plus `users/[id]` on `DetailLayout`, preserving the irreversible-delete confirmation.

- [ ] **Step 6: Port `feedback` as the `QueueList` proof, with bulk actions**

This is the surface that proves `QueueList` and `DataTable` selection before M1's Inbox depends on them. Feedback already has a single-row status change; add multi-select and a bulk status change through `ConsoleDataTable`'s `bulkActions`.

Keep the existing optimistic update with rollback via `useTransition`.

- [ ] **Step 7: Port the Overview**

`apps/web/app/admin/apps/kora/page.tsx` is a 6-line wrapper over `ProductOverviewLayout`. Do **not** port that shared layout — build a Kora-specific overview on `StatTile`. Its KPI route returns real data (Prometheus + key-health), but **if Prometheus is parked it must render `instrumentation-unavailable`**, not zeroes.

- [ ] **Step 8: All six ported tests pass**

Run: `pnpm --filter console test:unit`
Expected: PASS. Report the count — it must equal what those files asserted in `apps/web`.

- [ ] **Step 9: Verify no raw tables slipped in**

Run: `pnpm --filter console lint`
Expected: PASS. If the `no-restricted-syntax` rule fires, a page hand-rolled a table instead of using `ConsoleDataTable` — fix the page, do not weaken the rule.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(console): port Kora's eight surfaces onto the console kit"
```

---

### Task 6: Cutover — delete Kora from `apps/web` and start the ratchet

M0 ends with a real reduction, not two consoles carrying the same surfaces.

**Files:**
- Delete: `apps/web/app/admin/apps/kora/**` (8 pages + their components)
- Modify: `apps/web/lib/products/nav-config.ts` (remove `koraNav` and the `kora` rail context)
- Modify: `apps/web/next.config.ts` (redirects)
- Create: `apps/web/tests/route-count.test.ts`

- [ ] **Step 1: Add redirects before deleting anything**

In `apps/web/next.config.ts`'s `redirects()`, add one entry per removed Kora route pointing at the console origin. Use `process.env.NEXT_PUBLIC_CONSOLE_URL` with a sensible default, and `permanent: false` — these become permanent only once the console is the settled home.

Every pre-migration `/admin/apps/kora/*` URL must still resolve. Alert deep links and the mobile app depend on it.

- [ ] **Step 2: Delete the pages and the nav entries**

```bash
git rm -r apps/web/app/admin/apps/kora
```

Remove `koraNav` from `nav-config.ts`, drop `"kora"` from `RailContext`, from `getActiveContext`, from `getSecondaryNav` and from `EXACT_MATCH_ROOTS`. Run `nav-config`'s existing tests — they must still pass.

- [ ] **Step 3: Write the ratchet test**

This is what makes the migration a ratchet rather than a milestone with a cliff.

`apps/web/tests/route-count.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The admin route count in apps/web must only ever go DOWN. Raising this
// number means a surface was added to the console being retired — which is
// the drift that keeps a migration from ever finishing.
const CEILING = 62;   // set to the count after Kora's 8 were removed

function countPages(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) n += countPages(p);
    else if (e === "page.tsx") n += 1;
  }
  return n;
}

describe("admin route ratchet", () => {
  it("does not grow", () => {
    const n = countPages("app/admin");
    expect(n).toBeLessThanOrEqual(CEILING);
  });
});
```

- [ ] **Step 4: Set `CEILING` to the real number and run everything**

```bash
find apps/web/app/admin -name page.tsx | wc -l      # put this number in CEILING
pnpm --filter web test:unit && pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build
pnpm --filter console test:unit && pnpm --filter console build
```

- [ ] **Step 5: Verify the redirects actually land**

Start both apps and confirm `/admin/apps/kora/foods` on `web` redirects to the console's equivalent. State the observed status codes in the report — a redirect that 404s at its destination passes a naive parity test while breaking the operator.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): move Kora to apps/console, add redirects and the route ratchet"
```

---

## Verification

- [ ] `pnpm test` at the root — all packages green
- [ ] `pnpm --filter console lint` — PASS at `--max-warnings 0`, with zero raw `<table>` outside `components/kit/`
- [ ] `pnpm --filter web build` and `pnpm --filter console build` — both PASS
- [ ] `apps/web` admin route count strictly lower than before, ratchet test enforcing it
- [ ] Every `/admin/apps/kora/*` URL still resolves
- [ ] `console-core` imports neither `react-dom` nor `react-native`; no icon is exported as a component

Manual, since automation cannot cover it:

- [ ] Kora Overview renders `instrumentation-unavailable` while Prometheus is parked — not zeroes
- [ ] Food edit still surfaces a 409 `stale_update` as a conflict, distinct from a duplicate-barcode 409
- [ ] Feedback bulk status change works and rolls back on failure

## Out of scope — deliberately

- `platform-data` (`lib/db`, `lib/metrics`) extraction — Kora needs none of it; lands with M1
- Launchpad, registry schema, ArgoCD reconcile — separate plan, scope extended by ADR-002
- Inbox, Business, ⌘K — M1
- `apps/mobile` — consumes `console-core` in M5; M0 only guarantees the package is renderer-free
