# Console Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy `apps/console` to `console.tesserix.app` with a live platform dashboard as its index.

**Architecture:** The console stays a thin renderer. It reads platform counts from `apps/web`'s existing `/api/admin/dashboard` over the cluster-internal service, forwarding the caller's session cookie, and renders them through the console kit. A second image (`tesserix-console`, built from `Dockerfile.console`) is promoted by the existing `tesserix-home` Kargo project alongside the web image. No data layer is extracted.

**Tech Stack:** Next.js 16 (App Router, Node runtime), React 19.2.3, TypeScript 5.9, Vitest, Docker, Helm, ArgoCD, Kargo.

**Spec:** `docs/superpowers/specs/2026-08-14-console-deployment-design.md`

## Global Constraints

- **No Go service changes.** Work in this repo stays in `apps/`, `packages/` and `.github/`.
- **Commit messages:** conventional commits, SINGLE LINE, no signature, no `Co-Authored-By` trailer.
- **Never commit directly to `tesserix-k8s` or `kargo-manifests`** — ArgoCD auto-syncs them to production. Those changes ship as PRs only.
- **This repo is public.** Do not write GCP project names, Artifact Registry paths, GSM secret keys or cluster-internal DNS into files in this repo. Refer to them by role; real values belong in the private infra PRs. `.github/workflows/*` may name the image (`tesserix-console`) since the existing workflow already names `tesserix-home`.
- **A 501 means instrumentation-unavailable; every other failure is an error.** The client must preserve HTTP status or that distinction is lost.
- **Money is minor units plus a currency.** The dashboard renders counts, not money — do not introduce a bare-number money value.
- **Image tag conventions are load-bearing:** `docker build --platform linux/amd64`, tags `main-<sha7>` and `latest`. Kargo's warehouse regex depends on them, and its `platform:` filter is deliberately omitted.
- Verify with `pnpm --filter console typecheck`, `test:unit`, `lint` (runs at `--max-warnings 0`) and `build`.

## File structure

```
apps/console/
  lib/
    platform-api.ts          # typed client for apps/web's admin API
    platform-api.test.ts
  app/(console)/
    page.tsx                 # the dashboard surface
    page.test.tsx
Dockerfile.console           # repo root, beside the existing Dockerfile
.github/workflows/ci.yml     # second image build/push
```

Infra manifests (Task 5) are authored in the sibling repos' working copies and shipped as PRs; they are not files in this repository.

---

### Task 1: The platform API client

The one place the console depends on the web app at runtime. Its job is to forward the session cookie, validate the response shape at the boundary, and **preserve the HTTP status on failure** so the surface can tell a parked endpoint from a broken one.

**Files:**
- Create: `apps/console/lib/platform-api.ts`
- Create: `apps/console/lib/platform-api.test.ts`
- Reference (do not modify): `apps/web/app/api/admin/dashboard/route.ts` — the contract being consumed

**Interfaces — Produces:**
```ts
export type LeadStatus = "new" | "contacted" | "qualified" | "converted" | "lost";

export interface PlatformDashboard {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<LeadStatus, number> };
  apps: { active: number };
  generated_at: string;
}

export class PlatformApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number);
}

export function parseDashboard(json: unknown): PlatformDashboard;
export function fetchDashboard(cookieHeader: string): Promise<PlatformDashboard>;
```

- [ ] **Step 1: Write the failing test**

`apps/console/lib/platform-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError, fetchDashboard, parseDashboard } from "./platform-api";

const VALID = {
  tenants: { total: 12, active: 9 },
  stores: { total: 4 },
  leads: {
    by_status: { new: 3, contacted: 2, qualified: 1, converted: 5, lost: 0 },
    total: 11,
  },
  apps: { active: 6 },
  generated_at: "2026-08-14T07:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDashboard", () => {
  it("accepts the documented shape", () => {
    expect(parseDashboard(VALID)).toEqual(VALID);
  });

  it("rejects a response missing a section rather than coercing it", () => {
    // A silently-wrong dashboard is worse than a visibly broken one: if the
    // contract drifts, the operator must see an error, not zeroes.
    const { tenants: _omitted, ...withoutTenants } = VALID;
    expect(() => parseDashboard(withoutTenants)).toThrow(PlatformApiError);
  });

  it("rejects a non-numeric count", () => {
    expect(() =>
      parseDashboard({ ...VALID, stores: { total: "4" } }),
    ).toThrow(PlatformApiError);
  });
});

describe("fetchDashboard", () => {
  it("forwards the caller's session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard("tx_session=abc123");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe("tx_session=abc123");
  });

  it("preserves a 501 so the surface can report instrumentation-unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 501 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 501 });
  });

  it("preserves a 500 as a plain error, distinct from 501", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces a transport failure as a PlatformApiError with no status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.status).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter console test:unit platform-api`
Expected: FAIL — `platform-api.ts` does not exist.

- [ ] **Step 3: Implement `platform-api.ts`**

```ts
const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface PlatformDashboard {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<LeadStatus, number> };
  apps: { active: number };
  generated_at: string;
}

/** Carries the HTTP status when there was one. A 501 means the endpoint is
 *  parked; anything else is a real failure. Losing the status here collapses
 *  that distinction and a parked plane starts reading as broken. */
export class PlatformApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
  }
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`dashboard: ${path} is not a number`);
  }
  return value;
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new PlatformApiError(`dashboard: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

export function parseDashboard(json: unknown): PlatformDashboard {
  const root = obj(json, "response");
  const tenants = obj(root.tenants, "tenants");
  const stores = obj(root.stores, "stores");
  const leads = obj(root.leads, "leads");
  const apps = obj(root.apps, "apps");
  const byStatus = obj(leads.by_status, "leads.by_status");

  const buckets = {} as Record<LeadStatus, number>;
  for (const status of LEAD_STATUSES) {
    buckets[status] = num(byStatus[status], `leads.by_status.${status}`);
  }

  if (typeof root.generated_at !== "string") {
    throw new PlatformApiError("dashboard: generated_at is missing");
  }

  return {
    tenants: {
      total: num(tenants.total, "tenants.total"),
      active: num(tenants.active, "tenants.active"),
    },
    stores: { total: num(stores.total, "stores.total") },
    leads: { total: num(leads.total, "leads.total"), by_status: buckets },
    apps: { active: num(apps.active, "apps.active") },
    generated_at: root.generated_at,
  };
}

// Cluster-internal by default so dashboard reads never egress to the public
// internet. Overridden per environment; the localhost default is dev only.
const WEB_ORIGIN = process.env.WEB_INTERNAL_ORIGIN ?? "http://localhost:3002";

export async function fetchDashboard(
  cookieHeader: string,
): Promise<PlatformDashboard> {
  let response: Response;
  try {
    response = await fetch(`${WEB_ORIGIN}/api/admin/dashboard`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
  } catch (cause) {
    throw new PlatformApiError(
      `dashboard: request failed (${(cause as Error).message})`,
    );
  }

  if (!response.ok) {
    throw new PlatformApiError(
      `dashboard: responded ${response.status}`,
      response.status,
    );
  }

  return parseDashboard(await response.json());
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter console test:unit platform-api`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter console typecheck && pnpm --filter console lint
git add apps/console/lib/platform-api.ts apps/console/lib/platform-api.test.ts
git commit -m "feat(console): add a typed platform API client that preserves HTTP status"
```

---

### Task 2: The dashboard surface

The console's index. A server component that reads the session cookie, calls the client, and renders through the kit — including rendering `instrumentation-unavailable` rather than zeroes when the endpoint is parked.

**Files:**
- Create: `apps/console/app/(console)/page.tsx`
- Create: `apps/console/app/(console)/page.test.tsx`
- Reference (read the real API before using): `apps/console/components/kit/stat-tile.tsx`, `apps/console/components/kit/states.tsx`, `apps/console/components/kit/page-header.tsx`

**Interfaces — Consumes:** `fetchDashboard`, `PlatformApiError` from Task 1; `StatTile`, `SurfaceStateView`, `resolveState`, `PageHeader` from the kit.

`StatTileProps` is `{ label, value: string | number | Money, delta?, trend?, state?: SurfaceState, href? }` — `state` is the prop to use; `loading` is deprecated.

`resolveState` takes `{ isLoading, error, rows, filtered }` and returns a `SurfaceState`. For a page-level failure, build the state directly rather than forcing a rows-shaped call:
- `PlatformApiError` with `status === 501` → `{ kind: "instrumentation-unavailable" }`
- any other error → `{ kind: "error", message }`

- [ ] **Step 1: Write the failing test**

`apps/console/app/(console)/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlatformApiError } from "@/lib/platform-api";
import { DashboardView, dashboardState } from "./page";

const DATA = {
  tenants: { total: 12, active: 9 },
  stores: { total: 4 },
  leads: {
    by_status: { new: 3, contacted: 2, qualified: 1, converted: 5, lost: 0 },
    total: 11,
  },
  apps: { active: 6 },
  generated_at: "2026-08-14T07:00:00.000Z",
};

describe("dashboardState", () => {
  it("maps a 501 to instrumentation-unavailable, not an error", () => {
    expect(dashboardState(new PlatformApiError("parked", 501))).toEqual({
      kind: "instrumentation-unavailable",
    });
  });

  it("maps a 500 to an error", () => {
    expect(dashboardState(new PlatformApiError("boom", 500))).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("maps a transport failure to an error", () => {
    expect(dashboardState(new PlatformApiError("ECONNREFUSED"))).toEqual({
      kind: "error",
      message: "ECONNREFUSED",
    });
  });

  it("reports ready when data arrived", () => {
    expect(dashboardState(null)).toEqual({ kind: "ready" });
  });
});

describe("DashboardView", () => {
  // NOTE: assertions use plain truthiness rather than jest-dom matchers
  // (`toBeInTheDocument`), because the console's vitest setup may not register
  // jest-dom. If it does, tightening these is fine; do not add the dependency
  // just to satisfy this test.
  it("renders the platform counts", () => {
    render(<DashboardView data={DATA} state={{ kind: "ready" }} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("shows the parked message instead of zeroes when uninstrumented", () => {
    render(
      <DashboardView data={null} state={{ kind: "instrumentation-unavailable" }} />,
    );
    // The whole point: a parked plane must never render a confident 0.
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByText(/not measured/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter console test:unit page`
Expected: FAIL — `./page` does not export `DashboardView`.

- [ ] **Step 3: Implement `page.tsx`**

Export `dashboardState` and `DashboardView` as named exports for testability; keep the default export as the async server component.

```tsx
import { cookies } from "next/headers";
import { PageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import type { SurfaceState } from "@/components/kit/states";
import {
  PlatformApiError,
  fetchDashboard,
  type PlatformDashboard,
} from "@/lib/platform-api";

const NOT_IMPLEMENTED = 501;

export function dashboardState(error: unknown): SurfaceState {
  if (error === null || error === undefined) return { kind: "ready" };
  if (error instanceof PlatformApiError && error.status === NOT_IMPLEMENTED) {
    return { kind: "instrumentation-unavailable" };
  }
  return { kind: "error", message: (error as Error).message };
}

export function DashboardView({
  data,
  state,
}: {
  data: PlatformDashboard | null;
  state: SurfaceState;
}) {
  if (state.kind !== "ready" || data === null) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Tenants" value="" state={state} />
        <StatTile label="Stores" value="" state={state} />
        <StatTile label="Active apps" value="" state={state} />
        <StatTile label="Leads" value="" state={state} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Tenants"
        value={data.tenants.total}
        delta={`${data.tenants.active} active`}
      />
      <StatTile label="Stores" value={data.stores.total} />
      <StatTile label="Active apps" value={data.apps.active} />
      <StatTile
        label="Leads"
        value={data.leads.total}
        delta={`${data.leads.by_status.new} new`}
      />
    </div>
  );
}

export default async function ConsoleHome() {
  const cookieHeader = (await cookies()).toString();

  let data: PlatformDashboard | null = null;
  let error: unknown = null;
  try {
    data = await fetchDashboard(cookieHeader);
  } catch (caught) {
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform"
        description="Estate health across every product."
      />
      <DashboardView data={data} state={dashboardState(error)} />
    </div>
  );
}
```

If `PageHeader`'s real props differ from `{ title, description }`, **follow the real API** and note it in the report — do not invent props.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter console test:unit page`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter console typecheck && pnpm --filter console lint && pnpm --filter console build
git add apps/console/app/\(console\)/page.tsx apps/console/app/\(console\)/page.test.tsx
git commit -m "feat(console): add the live platform dashboard as the console index"
```

---

### Task 3: `Dockerfile.console`

**Files:**
- Create: `Dockerfile.console` (repository root)
- Reference (do not modify): `Dockerfile` — the web image, whose shape this mirrors

- [ ] **Step 1: Write the Dockerfile**

Mirror the existing root `Dockerfile` exactly in structure — same base images, same non-root user, same standalone-output copy pattern — changing only:
- the workspace manifests copied in the dependency layer: add `apps/console/package.json`, `packages/console-core/package.json` and `packages/platform-auth/package.json`; drop `apps/web` and `apps/mobile` if they are not needed to resolve the workspace (keep them if pnpm requires the full set — verify by building)
- the build target: `apps/console`
- the standalone copy paths: `/app/apps/console/.next/standalone`, `.next/static`, and `public` if present
- the entrypoint: `node apps/console/server.js`
- the exposed port: keep the same container port convention as the web image

Read the existing `Dockerfile` first and follow it line for line. Do not restructure it.

- [ ] **Step 2: Build the image locally and verify it starts**

```bash
docker build --platform linux/amd64 -f Dockerfile.console -t tesserix-console:dev .
docker run --rm -d --name console-smoke -p 3103:3000 \
  -e NEXT_PUBLIC_WEB_URL=http://localhost:3002 tesserix-console:dev
curl -si http://localhost:3103/ | head -1
docker rm -f console-smoke
```

Expected: the image builds, and the unauthenticated request returns a **redirect (3xx), not a 200** — the session gate must survive containerisation. Record the observed status line in the report.

If Docker is unavailable in the environment, report that plainly rather than marking this step done.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.console
git commit -m "build: add Dockerfile.console for the console image"
```

---

### Task 4: CI builds and pushes the console image

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the second image build**

The workflow currently builds one image from the root `Dockerfile` on pushes to `main` only, tagging `main-<sha7>` and `latest`. Add a second build/push for the console using `Dockerfile.console` and image name `tesserix-console`, under the same `if` condition and with **identical** tag and platform conventions:

- `--platform linux/amd64`
- tags `main-<sha7>` and `latest`

These are not stylistic: the Kargo warehouse matches `^main-[a-f0-9]{7,12}$` and deliberately omits a `platform:` filter, so a multi-arch manifest or a different tag form silently breaks promotion.

Keep the existing web image build untouched.

- [ ] **Step 2: Validate the workflow parses**

```bash
pnpm dlx yaml-lint .github/workflows/ci.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
```

Expected: parses cleanly. CI itself is the real verification, on push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build and push the console image alongside the web image"
```

---

### Task 5: Infrastructure manifests (PRs to other repositories)

**This task does not commit to this repository.** It produces two PRs. `tesserix-k8s` and `kargo-manifests` auto-sync to production — never commit to them directly, never merge them yourself.

**Working copies:** `../../tesserix-k8s` and `../../kargo-manifests` relative to this repo's root (adjust if they live elsewhere; confirm before writing).

**Files (in `tesserix-k8s`):**
- Create: a `console` chart under `charts/apps/`, modelled on `charts/apps/company/`
- Create: an ArgoCD Application for it under `argocd/prod/apps/global/`, and register it in that directory's `kustomization.yaml`

**Files (in `kargo-manifests`):**
- Modify: `projects/tesserix-home/warehouses/services.yaml` — add the console image subscription
- Modify: `projects/tesserix-home/stages/prod.yaml` — add the console app to the `argocd-update` step

- [ ] **Step 1: Author the chart**

Copy `charts/apps/company/` as the model and reduce it. Include: Deployment, Service, ServiceAccount, Ingress, VirtualService, ConfigMap, ExternalSecret, NetworkPolicy, PodDisruptionBudget, AuthorizationPolicy. **Omit** HPA, VPA, KEDA ScaledObject, uptime-probe CronJob and rollout RBAC — there is no traffic to justify them yet.

Configuration the chart must set:
- host `console.tesserix.app`
- the session cookie domain, matching the web deployment's value so the cookie is shared
- the public web origin, so the console's unauthenticated redirect points at the real login rather than its localhost default
- the cluster-internal web origin, consumed as `WEB_INTERNAL_ORIGIN` by the Task 1 client
- the session encryption key, sourced from **the same secret key as the web deployment**

Carry a comment on the shared secret naming both consumers and stating that rotation must be simultaneous — mirroring the existing precedent in the same chart for a token shared with another admin workload.

- [ ] **Step 2: Verify the chart renders**

```bash
helm template console charts/apps/console -f charts/apps/console/values.yaml | head -40
```

Expected: renders without error, and the rendered host is `console.tesserix.app`. If `helm` is unavailable, say so in the report rather than skipping silently.

- [ ] **Step 3: Add the Kargo subscription and promotion step**

In the warehouse, add a second image subscription for the console image alongside the existing one. **Preserve both documented constraints**: no `platform:` filter, and keep `allowTagsRegexes` pinned to the `main-<sha7>` form. Do not alter the existing web subscription.

In the prod Stage, add a second entry to the `argocd-update` step's `apps` list for the console Application, using `imageFrom(...)` against the console image, exactly mirroring the existing `company` entry.

- [ ] **Step 4: Check the Istio policy**

Confirm the existing admin-surface deny policy does not block the console workload, and add an AuthorizationPolicy permitting console → web on the admin API path. State in the report what the existing policy does and why the new workload is or is not affected — do not assume compatibility.

- [ ] **Step 5: Open both PRs**

```bash
# in each repo, on a fresh branch off its default branch
git checkout -b feat/console-deploy
git add -A
git commit -m "feat(console): add console chart, argocd app and kargo promotion"
git push -u origin feat/console-deploy
gh pr create --base main --title "feat(console): deploy the platform console to console.tesserix.app" --body "<summary>"
```

The PR body must state: the shared session key and its rotation coupling, that the warehouse edit is additive and preserves the two documented gotchas, and that DNS for `console.tesserix.app` is a separate manual step.

- [ ] **Step 6: Report the PR URLs**

Do not merge. Report both URLs and stop.

**Not owned by this plan — a human step:** DNS for `console.tesserix.app` must be pointed at the ingress. Nothing in this plan creates it, and the deployment is unreachable until it exists. Call it out explicitly when reporting the PRs rather than leaving it implied.

---

## Verification

- [ ] `pnpm test` at the root — all packages green
- [ ] `pnpm --filter console lint` — PASS at `--max-warnings 0`
- [ ] `pnpm --filter console build` — PASS
- [ ] `Dockerfile.console` builds and the container redirects an unauthenticated request rather than serving 200
- [ ] CI builds and pushes both images on merge to `main`
- [ ] Both infra PRs open, neither merged

Manual, after the infra PRs merge and DNS lands:

- [ ] `console.tesserix.app` redirects an unauthenticated visitor to login
- [ ] A session established on the web origin resolves on `console.tesserix.app` without re-login
- [ ] The dashboard renders live counts
- [ ] With the endpoint failing, the dashboard shows an error; with it returning 501, it shows instrumentation-unavailable — never zeroes

## Out of scope — deliberately

- `platform-data` extraction (`lib/db`, `lib/metrics`) — M1
- Porting Kora or any product surface — still gated on delivery in other repos
- Autoscaling, VPA, KEDA, uptime probes for the console — no traffic yet
- Any change to how `apps/web` is built, promoted or served
