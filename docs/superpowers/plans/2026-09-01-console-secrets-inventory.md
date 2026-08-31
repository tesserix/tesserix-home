# Console secrets inventory — Implementation Plan (phase 3a of the cutover)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console can list every secret in the estate, showing which store each lives in and flagging the ones no app can read.

**Architecture:** A `secrets-api` client mirroring the existing `platform-api` client — same operator token, same error type, a second base URL. A server component assembles the inventory by walking the secret tree, derives the orphan flag from OpenBao grants, and renders it. The page ships **unlisted**: routed and reachable, with no sidebar entry until the chart cutover lands.

**Tech Stack:** Next.js 16 App Router (React 19, server components), TypeScript, `@tesserix/web` primitives, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md` (the product design — §5 the flow, §6 the two stores) and `docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md` (the cutover — §6 how the console calls it, §9 sequencing).

**Visual design:** the approved prototype, saved at
`/Users/Mahesh.Sangawar/.claude-personal/projects/-Users-Mahesh-Sangawar-personal-tesserix-new-tesserix-home/3c807e87-0b65-4d2d-832c-5889e7027eb8/tool-results/artifact-1ce7c134-1788164522-0334.html`
Read its `Secrets` section before building the table. It is the authority on layout, the filter row, the chips and the counts — this plan does not restate it.

## Scope

This is **phase 3a of three**. Spec §9 step 3 (the console surface) is too large for one plan, so:

- **3a — this plan.** The client, and the read-only inventory. Deliverable: you can see the estate's secrets, with orphans flagged. Nothing mutates.
- **3b — later.** Describe/inspector, writing a value, delete/restore, access grants, whitelist proposals, the reviews queue.
- **3c — later.** Bell notifications (predecessor spec §8), which refactors `NotificationItem` into a discriminated union that tickets also flow through.

Each produces working, testable software on its own. Do not implement 3b or 3c here.

## Global Constraints

- The console reaches `secrets-api` with the **operator's existing Zitadel token** — the same token, store and error handling as `platform-api`. No new client, no second login, nothing added to `operator-token-store`.
- **`secrets-api` returns no secret values, ever.** Its `Store` interface has no `Read` method. Nothing in this plan may present a UI affordance implying a value can be retrieved.
- Every response is **parsed and validated at the boundary**, never trusted — follow `lib/tenants.ts`'s `parseEstateTenants` idiom, not a bare cast.
- The page is **unlisted**: a route entry in `packages/console-core/src/routes.ts`, and **no** sidebar nav entry. Adding the nav entry is a one-line follow-up after the chart cutover.
- Capability is `platform` (spec §4). Reading the inventory needs no verb.
- The Zitadel **project** id is `386377618200461939` (`platform-console`), per
  `docs/RUNBOOK-ZITADEL-IDENTITY.md`. That is what a token carries in `aud`, what
  `ZITADEL_PROJECT_ID` is set to, and what any test fixture standing for an
  audience must use. **`386377229942128837` is the Tesserix ORGANIZATION, not a
  project.** Both are real and both appear in a token, in different positions —
  the roles claim KEY is `urn:zitadel:iam:org:project:<projectId>:roles`, while
  the org id appears inside the claim VALUE. Using the org id where a project id
  belongs passes self-consistent tests and misleads whoever next debugs a live
  audience mismatch; it had to be corrected in secrets-api once already (#475).
- The console OIDC application is `386382971877196703` — that is
  `ZITADEL_CONSOLE_CLIENT_ID`, a third distinct id. Do not substitute it for either
  of the above.
- Commit messages: single line, conventional-commit prefix, no signature, no Co-Authored-By trailer.
- Every test is **mutated before it is trusted**: make it fail, then restore.

---

### Task 1: The secrets-api client

**Files:**
- Create: `apps/console/lib/secrets-api.ts`
- Create: `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: `PlatformApiError` from `./platform-api-error`; `getPlatformApiToken` from `./auth/platform-token`.
- Produces:
  - `function secretsApiOrigin(): string | undefined`
  - `async function secretsRequest(label: string, path: string): Promise<unknown>`

- [ ] **Step 1: Read the pattern you are mirroring**

Read `apps/console/lib/platform-api.ts` — specifically `platformApiOrigin()`, `platformRequest()`, and one complete `fetchX` such as `fetchEstateTenants` (around line 706). Read `apps/console/lib/platform-api-error.ts` in full.

Your client is the same shape against a different origin. **Reuse `PlatformApiError`** rather than defining a parallel error type: it already carries `status` and `noOperatorToken`, the console's error surfaces already branch on it, and a second error hierarchy would mean every consumer handles two.

- [ ] **Step 2: Write the failing tests**

Create `apps/console/lib/secrets-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "./platform-api-error";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("secretsApiOrigin", () => {
  it("is undefined when SECRETS_API_ORIGIN is unset", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "");
    const { secretsApiOrigin } = await import("./secrets-api");
    expect(secretsApiOrigin()).toBeUndefined();
  });

  it("is the configured origin with any trailing slash removed", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secret-service-api.secret-service.svc.cluster.local:8080/");
    const { secretsApiOrigin } = await import("./secrets-api");
    expect(secretsApiOrigin()).toBe("http://secret-service-api.secret-service.svc.cluster.local:8080");
  });
});

describe("secretsRequest", () => {
  it("refuses with 501 when the origin is unset, naming the variable", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "");
    const { secretsRequest } = await import("./secrets-api");

    await expect(secretsRequest("inventory", "/api/secrets")).rejects.toMatchObject({
      status: 501,
    });
    await expect(secretsRequest("inventory", "/api/secrets")).rejects.toThrow(/SECRETS_API_ORIGIN/);
  });

  // The operator token is the ONLY credential. Sending the request without one
  // would 401 and read as an outage rather than as a session problem, so the
  // client refuses before the network call and says which it is.
  it("refuses when there is no operator token, and says so distinguishably", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => null }));
    const { secretsRequest } = await import("./secrets-api");

    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).noOperatorToken).toBe(true);
  });

  it("sends the operator token as a bearer credential", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "tok-123" }));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ prefix: "/", entries: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { secretsRequest } = await import("./secrets-api");
    await secretsRequest("inventory", "/api/secrets");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://secrets/api/secrets");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-123");
  });

  // A 403 means the operator lacks `platform`. It must NOT be reported as a
  // missing session: telling someone to sign in again for a permission they
  // were never granted sends them round a loop that cannot help.
  it("preserves the upstream status and does not claim a missing token on 403", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "tok-123" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));

    const { secretsRequest } = await import("./secrets-api");
    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);

    expect((caught as PlatformApiError).status).toBe(403);
    expect((caught as PlatformApiError).noOperatorToken).toBe(false);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/console && pnpm vitest run lib/secrets-api.test.ts`
Expected: FAIL — cannot resolve `./secrets-api`.

- [ ] **Step 4: Implement**

Create `apps/console/lib/secrets-api.ts`. Follow `platform-api.ts`'s structure closely — including how it reads the environment at call time rather than module load, which is what makes it testable.

```ts
import { PlatformApiError } from "./platform-api-error";
import { getPlatformApiToken } from "./auth/platform-token";

/**
 * Where secrets-api lives. A second origin, not a second client: the token,
 * the token store and the error type are all shared with platform-api, because
 * both services verify the same Zitadel project audience and the console holds
 * exactly one operator token.
 *
 * Read at call time, not at module load, so tests can stub it and so a
 * misconfigured deployment reports the problem per request rather than
 * failing to start.
 */
export function secretsApiOrigin(): string | undefined {
  const raw = (process.env.SECRETS_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return raw === "" ? undefined : raw;
}

export async function secretsRequest(label: string, path: string): Promise<unknown> {
  const origin = secretsApiOrigin();
  if (!origin) {
    throw new PlatformApiError(
      `${label}: SECRETS_API_ORIGIN is not set`,
      501,
    );
  }

  const token = await getPlatformApiToken();
  if (!token) {
    // Refused before the network call. A request without the token would come
    // back 401 and be indistinguishable from the service being down.
    throw new PlatformApiError(`${label}: no operator token`, undefined, {
      noOperatorToken: true,
    });
  }

  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    // The upstream status is preserved rather than flattened. 403 (lacks the
    // `platform` capability) and 401 (session gone) need different answers from
    // the caller, and only the status tells them apart.
    throw new PlatformApiError(`${label}: secrets-api returned ${response.status}`, response.status);
  }

  return response.json();
}
```

Check `PlatformApiError`'s real constructor signature before writing this — if its options shape differs, match the real one rather than this sketch.

- [ ] **Step 5: Run and watch them pass**

Run: `cd apps/console && pnpm vitest run lib/secrets-api.test.ts`
Expected: all pass.

- [ ] **Step 6: Mutate each guarded property**

Run each, confirm the named test fails, revert, confirm green.

| mutation in `secrets-api.ts` | must fail |
|---|---|
| drop the `!token` guard entirely | "refuses when there is no operator token" |
| change `Bearer ${token}` to just `${token}` | "sends the operator token as a bearer credential" |
| replace `response.status` in the throw with a literal `500` | "preserves the upstream status" |
| return `raw` unconditionally from `secretsApiOrigin` | "is undefined when SECRETS_API_ORIGIN is unset" |

If any mutation leaves the suite green, that test is not testing what it claims — fix it and say so in your report.

- [ ] **Step 7: Commit**

```bash
git add apps/console/lib/secrets-api.ts apps/console/lib/secrets-api.test.ts
git commit -m "feat(console): add a secrets-api client using the operator's existing token"
```

---

### Task 2: Inventory types, parsing, and the orphan rule

The correctness heart of this plan. Read it twice before writing.

**Files:**
- Create: `apps/console/lib/secrets.ts`
- Create: `apps/console/lib/secrets.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (pure functions over JSON).
- Produces:
  - `type SecretStore = "openbao" | "gcpsm"`
  - `interface SecretListEntry { name: string; isFolder: boolean }`
  - `interface InventoryRow { path: string; store: SecretStore; hasReader: boolean | null }`
  - `interface SecretsInventory { rows: InventoryRow[]; counts: { all: number; openbao: number; gcpsm: number; noReader: number } }`
  - `function parseSecretList(json: unknown): SecretListEntry[]`
  - `function parseGrantPaths(json: unknown): string[]`
  - `function buildInventory(input: { openbao: string[]; gcpsm: string[]; grantedPaths: string[] }): SecretsInventory`

- [ ] **Step 1: Understand the two rules that make this correct**

**Rule 1 — the orphan flag applies to OpenBao only.** Predecessor spec §6:

> On a GSM secret, the "Who can read this" card is replaced, not emptied. It says access is governed by GCP IAM and there is nothing for the console to propose. Rendering an empty reader list instead would conflate two different facts — "nothing can read this" and "this tool does not manage who reads this" — and the first of those is the alarm the orphan flag exists to raise.

So a Google Secret Manager secret is **never** an orphan. Its readers are IAM bindings the console cannot see. Marking every GSM secret "No reader" would swamp the real alarm with false ones and destroy the flag's meaning. This is why `hasReader` is `boolean | null` and not `boolean`: `null` means *not knowable here*, which is a different fact from `false`.

**Rule 2 — orphans sort to the top and are counted above the list.** Predecessor spec §5:

> Orphans sort to the top of the list and are counted above it; a chip in a row of chips loses a horizontal scan.

The count is over the **whole set**, not the filtered view.

- [ ] **Step 2: Write the failing tests**

Create `apps/console/lib/secrets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildInventory, parseGrantPaths, parseSecretList } from "./secrets";

describe("parseSecretList", () => {
  it("reads the entries array", () => {
    expect(parseSecretList({ prefix: "/", entries: [{ name: "db", isFolder: true }] }))
      .toEqual([{ name: "db", isFolder: true }]);
  });

  it("rejects a response that is not shaped like a listing", () => {
    expect(() => parseSecretList({ entries: "nope" })).toThrow();
    expect(() => parseSecretList(null)).toThrow();
  });

  // Absent isFolder must not silently become `false` — a folder treated as a
  // secret would be listed as one and then fail to describe.
  it("rejects an entry missing isFolder", () => {
    expect(() => parseSecretList({ entries: [{ name: "db" }] })).toThrow();
  });
});

describe("buildInventory", () => {
  const base = { openbao: ["mark8ly/db"], gcpsm: [], grantedPaths: [] };

  it("flags an OpenBao secret with no grant as having no reader", () => {
    const { rows } = buildInventory(base);
    expect(rows).toEqual([{ path: "mark8ly/db", store: "openbao", hasReader: false }]);
  });

  it("does not flag an OpenBao secret that has a grant", () => {
    const { rows } = buildInventory({ ...base, grantedPaths: ["mark8ly/db"] });
    expect(rows[0].hasReader).toBe(true);
  });

  // The rule that a naive implementation gets wrong. GSM readers are IAM
  // bindings the console cannot see, so "no reader" is unknowable, not false.
  it("never flags a Google Secret Manager secret, even with no grants", () => {
    const { rows } = buildInventory({ openbao: [], gcpsm: ["stripe/key"], grantedPaths: [] });
    expect(rows[0]).toEqual({ path: "stripe/key", store: "gcpsm", hasReader: null });
  });

  it("counts only OpenBao orphans as noReader", () => {
    const { counts } = buildInventory({
      openbao: ["a", "b"],
      gcpsm: ["c", "d", "e"],
      grantedPaths: ["a"],
    });
    expect(counts).toEqual({ all: 5, openbao: 2, gcpsm: 3, noReader: 1 });
  });

  it("sorts orphans to the top, then by path", () => {
    const { rows } = buildInventory({
      openbao: ["zed", "alpha", "beta"],
      gcpsm: [],
      grantedPaths: ["alpha", "zed"],
    });
    expect(rows.map((r) => r.path)).toEqual(["beta", "alpha", "zed"]);
  });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd apps/console && pnpm vitest run lib/secrets.test.ts`
Expected: FAIL — cannot resolve `./secrets`.

- [ ] **Step 4: Implement**

Create `apps/console/lib/secrets.ts`. Write `parseSecretList` and `parseGrantPaths` as real validators that throw on a wrong shape — follow `lib/tenants.ts`'s idiom, not a cast.

For `buildInventory`, the two rules above are the whole logic:

```ts
export function buildInventory(input: {
  openbao: string[];
  gcpsm: string[];
  grantedPaths: string[];
}): SecretsInventory {
  const granted = new Set(input.grantedPaths);

  const rows: InventoryRow[] = [
    ...input.openbao.map((path) => ({
      path,
      store: "openbao" as const,
      hasReader: granted.has(path),
    })),
    // hasReader is null, not false. A GSM secret's readers are IAM bindings
    // this console cannot see, so "nothing can read this" is not a claim it is
    // entitled to make — and making it would drown the real orphans.
    ...input.gcpsm.map((path) => ({ path, store: "gcpsm" as const, hasReader: null })),
  ];

  // Orphans first — the alarm has to survive a scan of a long list — then
  // alphabetically so the order is stable between loads.
  rows.sort((a, b) => {
    const aOrphan = a.hasReader === false;
    const bOrphan = b.hasReader === false;
    if (aOrphan !== bOrphan) return aOrphan ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    rows,
    counts: {
      all: rows.length,
      openbao: input.openbao.length,
      gcpsm: input.gcpsm.length,
      // Counted over the whole set, not the filtered view: a count that moved
      // with the filter would answer a question nobody asked.
      noReader: rows.filter((r) => r.hasReader === false).length,
    },
  };
}
```

- [ ] **Step 5: Run and watch them pass**

Run: `cd apps/console && pnpm vitest run lib/secrets.test.ts`
Expected: all pass.

- [ ] **Step 6: Mutate — the GSM rule especially**

| mutation in `secrets.ts` | must fail |
|---|---|
| give gcpsm rows `hasReader: granted.has(path)` instead of `null` | "never flags a Google Secret Manager secret" AND "counts only OpenBao orphans" |
| change `noReader` to count `!r.hasReader` | "counts only OpenBao orphans" (null is falsy, so GSM rows would count) |
| drop the orphan-first comparison, sorting by path only | "sorts orphans to the top" |
| make `parseSecretList` return `json.entries` unchecked | "rejects a response that is not shaped like a listing" |

The second mutation is the subtle one and the reason `hasReader` is tri-state: `!null` is `true`, so a `!r.hasReader` count silently includes every GSM secret. Confirm it fails.

- [ ] **Step 7: Commit**

```bash
git add apps/console/lib/secrets.ts apps/console/lib/secrets.test.ts
git commit -m "feat(console): derive the secrets inventory and its no-reader flag"
```

---

### Task 3: Walking the secret tree

`GET /api/secrets?prefix=…` returns **one level** — `{prefix, entries: [{name, isFolder}]}`. There is no flat-inventory endpoint. Assembling the estate list means walking.

**Files:**
- Modify: `apps/console/lib/secrets-api.ts`
- Modify: `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: `secretsRequest` (Task 1), `parseSecretList` (Task 2).
- Produces: `async function fetchSecretPaths(store: SecretStore): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Add to `apps/console/lib/secrets-api.test.ts`. Drive the walk with a fake tree so the recursion is what is under test:

```ts
describe("fetchSecretPaths", () => {
  function treeFetch(tree: Record<string, Array<{ name: string; isFolder: boolean }>>) {
    return vi.fn(async (url: string) => {
      const prefix = new URL(url).searchParams.get("prefix") ?? "/";
      return new Response(JSON.stringify({ prefix, entries: tree[prefix] ?? [] }), { status: 200 });
    });
  }

  it("returns leaf paths, not folders", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "t" }));
    vi.stubGlobal("fetch", treeFetch({
      "/": [{ name: "mark8ly", isFolder: true }, { name: "root-key", isFolder: false }],
      "/mark8ly/": [{ name: "db", isFolder: false }],
    }));

    const { fetchSecretPaths } = await import("./secrets-api");
    expect((await fetchSecretPaths("openbao")).sort()).toEqual(["mark8ly/db", "root-key"]);
  });

  // A backend that returned a folder containing itself would otherwise walk
  // forever and hang the page rather than failing.
  it("stops at the depth limit instead of recursing forever", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "t" }));
    const selfReferential = vi.fn(async (url: string) => {
      const prefix = new URL(url).searchParams.get("prefix") ?? "/";
      return new Response(
        JSON.stringify({ prefix, entries: [{ name: "loop", isFolder: true }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", selfReferential);

    const { fetchSecretPaths } = await import("./secrets-api");
    await expect(fetchSecretPaths("openbao")).resolves.toBeInstanceOf(Array);
    expect(selfReferential.mock.calls.length).toBeLessThan(100);
  });

  it("asks for the requested store", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "t" }));
    const fetchMock = treeFetch({ "/": [] });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretPaths } = await import("./secrets-api");
    await fetchSecretPaths("gcpsm");

    expect(fetchMock.mock.calls[0][0]).toContain("backend=gcpsm");
  });
});
```

Before writing the implementation, **confirm how the backend is selected** — read `secrets-api/internal/api/handlers/secrets.go`'s `store(c)` helper to see whether it reads a `backend` query parameter, a header, or something else, and match it. If it differs from `backend=`, fix the test's expectation to the real thing and note it in your report.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/console && pnpm vitest run lib/secrets-api.test.ts -t fetchSecretPaths`
Expected: FAIL — `fetchSecretPaths` is not exported.

- [ ] **Step 3: Implement the walk**

Breadth-first with an explicit depth bound and a visited set. Both bounds are load-bearing, so comment why:

```ts
// The API lists one level at a time, so the estate inventory is a walk. Two
// bounds, both deliberate:
//
//   MAX_DEPTH  — a backend that returned a folder containing itself would
//                otherwise recurse until the page hung. A bounded walk that
//                returns a short list is diagnosable; a hang is not.
//   MAX_NODES  — caps the request count for a pathological tree, so one bad
//                prefix cannot turn a page load into hundreds of calls.
const MAX_DEPTH = 8;
const MAX_NODES = 512;
```

Walk from `/`, collecting non-folder entries as full paths (parent prefix + name, with the leading slash trimmed so paths read `mark8ly/db`). Use the visited set on the prefix so a cycle terminates.

- [ ] **Step 4: Run and watch them pass**

Run: `cd apps/console && pnpm vitest run lib/secrets-api.test.ts`
Expected: all pass, including Task 1's.

- [ ] **Step 5: Mutate**

| mutation | must fail |
|---|---|
| collect folder entries as paths too | "returns leaf paths, not folders" |
| remove the depth/visited bound | "stops at the depth limit" (it will hang or blow the call count — kill it after 30s and treat that as the failure) |

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/secrets-api.ts apps/console/lib/secrets-api.test.ts
git commit -m "feat(console): walk the secret tree to assemble the estate inventory"
```

---

### Task 4: The inventory fetch

**Files:**
- Modify: `apps/console/lib/secrets-api.ts`
- Modify: `apps/console/lib/secrets-api.test.ts`

**Interfaces:**
- Consumes: `fetchSecretPaths`, `buildInventory`, `parseGrantPaths`.
- Produces: `async function fetchSecretsInventory(): Promise<SecretsInventory>`

- [ ] **Step 1: Write the failing test**

One test that matters here: which backends are walked must come from the API, not be hardcoded.

```ts
describe("fetchSecretsInventory", () => {
  it("walks only the backends the API reports as enabled", async () => {
    // GET /api/backends is the authority on which stores this deployment has.
    // Hardcoding both would make the page fail on a deployment that runs one.
    // ...stub /api/backends to return only openbao, assert no gcpsm walk happened
  });

  it("derives readers from the grants endpoint", async () => {
    // ...stub grants, assert an ungranted openbao path comes back hasReader:false
  });
});
```

Write both out in full against the real endpoint shapes. Read `secrets-api/internal/api/handlers/secrets.go`'s `Backends` handler and `access.go`'s `ListGrants` first to get them right — do not guess the JSON.

- [ ] **Step 2-5: RED, implement, GREEN, mutate**

Implement `fetchSecretsInventory` by reading `/api/backends`, walking each enabled store, reading `/api/access/grants`, and passing all three into `buildInventory`.

Mutation: hardcode `["openbao", "gcpsm"]` instead of reading the endpoint — the first test must fail.

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/secrets-api.ts apps/console/lib/secrets-api.test.ts
git commit -m "feat(console): assemble the secrets inventory from the enabled backends"
```

---

### Task 5: The page, unlisted

**Files:**
- Create: `apps/console/app/(console)/platform/secrets/page.tsx`
- Create: `apps/console/app/(console)/platform/secrets/secrets-table.tsx`
- Create: `apps/console/app/(console)/platform/secrets/page.test.tsx`
- Modify: `packages/console-core/src/routes.ts`

**Interfaces:**
- Consumes: `fetchSecretsInventory`, `SecretsInventory`.
- Produces: the route `platform.secrets`.

- [ ] **Step 1: Read the two things you are matching**

Read `apps/console/app/(console)/platform/outbox/page.tsx` in full — it is the closest existing surface, and it shows how this codebase does the server component, the `SurfaceState`/`SurfaceError` shape, and the empty and error states. Match it rather than inventing a new page shape.

Then read the **`Secrets` section of the prototype** named at the top of this plan: the filter row (All / OpenBao / Google Secret Manager / No reader), the counts above the list, the row layout, and the chip styles (`chip ok`, `chip warn`, `chip bad`). The prototype is the visual authority; do not redesign it.

- [ ] **Step 2: Add the route entry — and no nav entry**

In `packages/console-core/src/routes.ts`, beside `platform.auditLog`:

```ts
  // The secrets inventory. `platform` because reading the estate's secret
  // NAMES and their reader state is a governance read, not a mutation — the
  // credential verb gates writing a value, not seeing that one exists.
  //
  // No `web` path: apps/web never served this. Its predecessor is
  // secret-service's own UI, a separate application being retired, which is
  // not what this field records.
  "platform.secrets": { mobile: "/platform/secrets", capability: "platform" },
```

**Do not add a sidebar entry.** The page ships unlisted until the chart cutover redeploys `secrets-api`; adding the nav entry is a deliberate one-line follow-up. If you find yourself editing a nav config, stop — that is not this task.

- [ ] **Step 3: Write the failing render test**

Follow `outbox/page.test.tsx`'s idiom. Assert, at minimum:

- an orphan row is marked, and a GSM row is **not** marked
- the counts render from `counts`, not from the rendered row count
- the empty state renders when there are no secrets
- a `PlatformApiError` with status 501 renders the "not configured" state rather than throwing

- [ ] **Step 4-6: RED, implement, GREEN**

Server component fetches, `secrets-table.tsx` renders. Keep the filter client-side over the already-fetched rows — the counts are over the whole set, so filtering must not recompute them.

- [ ] **Step 7: Mutate**

| mutation | must fail |
|---|---|
| render `counts.noReader` as `rows.filter(...).length` after filtering | the counts test |
| mark rows with `!row.hasReader` | the "GSM row is not marked" test |

- [ ] **Step 8: Commit**

```bash
git add apps/console/app/\(console\)/platform/secrets packages/console-core/src/routes.ts
git commit -m "feat(console): add the secrets inventory surface, unlisted until the cutover"
```

---

### Task 6: Whole-app verification

**Files:** none.

- [ ] **Step 1: Full checks**

```bash
cd apps/console
pnpm vitest run
pnpm tsc --noEmit
pnpm next build
```

`next build` is not optional and not covered by the other two: `tsc` and `vitest` cannot see server-only code reaching the browser bundle, and this task adds a server module that imports the operator token store. A build failure here is the expected way that mistake shows up.

Do not pipe any of this through `tail -N` or `head -N`.

- [ ] **Step 2: Confirm the surface is genuinely unlisted**

```bash
grep -rn "platform/secrets" apps/console/components apps/console/lib packages/console-core/src/nav.ts
```

Expected: no hit in any nav configuration. The route entry in `routes.ts` is the only registration.

---

## Self-review

**Spec coverage.** Predecessor §5's derived orphan flag → Task 2 and Task 5. §5's "orphans sort to the top, counted above the list" → Task 2's sort and counts, Task 5's render. §6's "GSM readers are IAM, not ours" → Task 2's tri-state `hasReader`, tested and mutated. Cutover spec §6's "same token, same store, same error handling" → Task 1. §9's unlisted sequencing → Task 5 Step 2 and Task 6 Step 2.

**Deliberately not covered:** describe/inspector, writing a value, grants, proposals, the reviews queue (3b); notifications (3c). The `Store`-has-no-`Read` test from cutover spec §10 belongs with 3b, where a value-writing UI first makes the guarantee user-visible — if 3b slips, file it rather than losing it.

**Type consistency.** `SecretStore`, `InventoryRow` and `SecretsInventory` are defined in Task 2 and consumed unchanged in Tasks 3, 4 and 5. `hasReader` is `boolean | null` everywhere — never widened to `boolean`, which is the mutation Task 2 Step 6 exists to catch.
