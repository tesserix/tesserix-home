# CRM Queues Console Cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the console's CRM due queue, drifting queue, and next-action write at the Go platform API instead of direct Postgres, behind the same `PLATFORM_API_ORIGIN` switch the tickets migration uses.

**Architecture:** No new Go code — `/v1/crm/queues/due`, `/v1/crm/queues/drifting` and `PUT /v1/crm/opportunities/{id}/next-action` already exist and are deployed with zero callers. A new server-only module `apps/console/lib/crm-queues.ts` becomes the seam: it exports the three functions the pages call today, dispatching to the platform API when `PLATFORM_API_ORIGIN` is set and to `crm-repo.ts` when it is not. `crm-repo.ts` is not modified — it stays a pure database module.

**Tech Stack:** Next.js 16 server components, TypeScript, Vitest. Go platform API (already built).

**Spec:** `docs/superpowers/specs/2026-08-21-console-off-direct-data-access.md`

## Global Constraints

- **Dual path.** `PLATFORM_API_ORIGIN` unset MUST be byte-for-byte today's behaviour. This is what makes the phase revertible by removing one variable. (Spec C9)
- **Parity only.** Do not fix #301 (erased contacts deciding follower bands) in this phase. Both sides are wrong identically and on purpose. (Spec C2)
- **`quietSince` is the SQL `COALESCE` value.** Never recompute it in TypeScript. (Spec C3)
- **Sentinels are wire values.** `__unassigned__`, `__unknown__` switch SQL from `=` to `IS NULL`. The platform API spells this differently — see Task 2. (Spec C3)
- **`server-only`.** Any module reading Postgres or tokens imports `server-only` as its first import, or it can reach the browser bundle. `pg` in the browser bundle broke main once (#299).
- **Run `npx next build` in `apps/console` before merging.** `tsc` resolves modules but does not bundle them; that is how main broke.
- Capability for every CRM route is `crm` alone. Do not invent `crm-write`.

---

### Task 1: The wire types and their parser

**Files:**
- Create: `apps/console/lib/crm-queue-wire.ts`
- Test: `apps/console/lib/crm-queue-wire.test.ts`

**Interfaces:**
- Consumes: `QueueRow`, `QueuePage` from `@/lib/db/crm-repo` (types only), `CrmStage` from `@/lib/crm`.
- Produces: `parseQueuePage(body: unknown, meta: unknown): QueuePage` — used by Task 3.

**Why this is its own task:** the platform API's JSON is field-for-field identical to the raw pg row the repo already maps, so the parser is small — but it is the one place a wrong field name silently produces `undefined` instead of an error. It gets its own tests.

The wire shape, from `platform-api/internal/modules/crm/internal/handler/testdata/due.json`:

```json
{ "success": true,
  "data": { "opportunities": [ { "id": "…", "organisation_id": "…", "organisation_name": "Dune",
      "product": null, "stage": "new", "owner": null, "next_action_at": "…",
      "next_action_note": "dune-unattributed", "last_contacted_at": null,
      "quiet_since": "…", "is_starred": false } ] },
  "meta": { "next_cursor": "…", "preceding_count": 0, "total": 4, "limit": 1 } }
```

`platformRequest` already strips the envelope and returns `data`, but `meta` is NOT returned by it today — Task 3 handles that.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseQueuePage } from "./crm-queue-wire";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  organisation_id: "22222222-2222-4222-8222-222222222222",
  organisation_name: "Dune",
  product: null,
  stage: "new",
  owner: null,
  next_action_at: "2026-08-21T00:00:00Z",
  next_action_note: "follow up",
  last_contacted_at: null,
  quiet_since: "2026-08-01T00:00:00Z",
  is_starred: false,
};

describe("parseQueuePage", () => {
  it("maps the platform API's snake_case row onto QueueRow", () => {
    const page = parseQueuePage({ opportunities: [row] }, { total: 4, preceding_count: 2 });
    expect(page.rows).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        organisationId: "22222222-2222-4222-8222-222222222222",
        organisationName: "Dune",
        product: null,
        stage: "new",
        owner: null,
        nextActionAt: "2026-08-21T00:00:00Z",
        nextActionNote: "follow up",
        lastContactedAt: null,
        quietSince: "2026-08-01T00:00:00Z",
        isStarred: false,
      },
    ]);
    expect(page.total).toBe(4);
    expect(page.precedingCount).toBe(2);
  });

  it("defaults cursors to null when meta omits them", () => {
    const page = parseQueuePage({ opportunities: [] }, { total: 0, preceding_count: 0 });
    expect(page.nextCursor).toBeNull();
    expect(page.previousCursor).toBeNull();
    expect(page.rows).toEqual([]);
  });

  it("carries cursors through when meta has them", () => {
    const page = parseQueuePage({ opportunities: [] },
      { total: 0, preceding_count: 0, next_cursor: "abc", previous_cursor: "xyz" });
    expect(page.nextCursor).toBe("abc");
    expect(page.previousCursor).toBe("xyz");
  });

  it("refuses a payload whose opportunities are not an array", () => {
    expect(() => parseQueuePage({ opportunities: {} }, {})).toThrow(/opportunities/);
  });

  it("refuses a row missing a required field rather than yielding undefined", () => {
    const { quiet_since: _dropped, ...missing } = row;
    expect(() => parseQueuePage({ opportunities: [missing] }, {})).toThrow(/quiet_since/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run lib/crm-queue-wire.test.ts`
Expected: FAIL — `Failed to resolve import "./crm-queue-wire"`.

- [ ] **Step 3: Write the implementation**

```ts
// `server-only` is deliberately NOT imported here: this module is pure data
// mapping with no database, no token and no `pg` import, and the queue views
// render its output. Keeping it browser-safe is what stops a future import
// from dragging the transport into the client bundle — the failure #299 fixed.

import type { QueuePage, QueueRow } from "@/lib/db/crm-repo";
import type { CrmStage } from "@/lib/crm";

/**
 * The platform API's queue row, exactly as `service/wire.go` renders it.
 *
 * Field for field the same as the raw pg row `crm-repo.ts` maps, because the
 * Go module was built to mirror it. That is why this parser is a rename rather
 * than a translation — and why a drift in either direction should fail loudly
 * here instead of arriving as `undefined` three components later.
 */
interface WireOpportunity {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  next_action_at: string | null;
  next_action_note: string | null;
  last_contacted_at: string | null;
  quiet_since: string;
  is_starred: boolean;
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw new Error(`crm queue: ${field} is not a string`);
  }
  return value;
}

function nullableString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`crm queue: ${field} is not a string or null`);
  }
  return value;
}

function toQueueRow(raw: unknown): QueueRow {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("crm queue: an opportunity was not an object");
  }
  const row = raw as Record<string, unknown>;
  return {
    id: requireString(row, "id"),
    organisationId: requireString(row, "organisation_id"),
    organisationName: requireString(row, "organisation_name"),
    product: nullableString(row, "product"),
    stage: requireString(row, "stage") as CrmStage,
    owner: nullableString(row, "owner"),
    nextActionAt: nullableString(row, "next_action_at"),
    nextActionNote: nullableString(row, "next_action_note"),
    lastContactedAt: nullableString(row, "last_contacted_at"),
    // Never recomputed from last_contacted_at/created_at here: it is the SQL
    // COALESCE the queue was ordered and filtered by, and a second copy of that
    // expression in TypeScript is exactly the drift the repo's comment warns of.
    quietSince: requireString(row, "quiet_since"),
    isStarred: row.is_starred === true,
  } satisfies QueueRow as QueueRow;
}

function readNumber(meta: Record<string, unknown>, field: string): number {
  const value = meta[field];
  return typeof value === "number" ? value : 0;
}

function readCursor(meta: Record<string, unknown>, field: string): string | null {
  const value = meta[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn one `/v1/crm/queues/*` response into the `QueuePage` the console's
 * existing views already take.
 *
 * `meta` is separate because the envelope splits them: `data` carries the rows,
 * `meta` carries the counts and cursors. A missing `meta` is not an error — an
 * empty queue legitimately has no cursors — but a missing count reads as 0
 * rather than NaN.
 */
export function parseQueuePage(data: unknown, meta: unknown): QueuePage {
  if (typeof data !== "object" || data === null) {
    throw new Error("crm queue: response data was not an object");
  }
  const payload = data as Record<string, unknown>;
  if (!Array.isArray(payload.opportunities)) {
    throw new Error("crm queue: opportunities was not an array");
  }
  const metaRecord =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  return {
    rows: payload.opportunities.map(toQueueRow),
    total: readNumber(metaRecord, "total"),
    precedingCount: readNumber(metaRecord, "preceding_count"),
    nextCursor: readCursor(metaRecord, "next_cursor"),
    previousCursor: readCursor(metaRecord, "previous_cursor"),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/console && npx vitest run lib/crm-queue-wire.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/crm-queue-wire.ts apps/console/lib/crm-queue-wire.test.ts
git commit -m "feat(console): parse the platform API's CRM queue rows"
```

---

### Task 2: Translate the console's filter into the platform API's query grammar

**Files:**
- Create: `apps/console/lib/crm-queue-query.ts`
- Test: `apps/console/lib/crm-queue-query.test.ts`

**Interfaces:**
- Consumes: `QueueFilter` from `@/lib/db/crm-repo` (type only); `UNASSIGNED_PRODUCT`, `UNKNOWN_COUNTRY`, `UNKNOWN_FOLLOWERS` from `@/lib/db/crm-filters`.
- Produces: `queueQuery(filter: QueueFilter, limit: number, cursor?: string): URLSearchParams` — used by Task 3.

**Why this is separate, and the trap it exists to hold:** the two sides spell "no value" differently. The console encodes it as a **sentinel string in the value** (`product=__unassigned__`); the platform API encodes it as a **separate boolean parameter** (`product_unset=true`), and it returns 422 if both are sent for one axis. This is the single highest-risk translation in the phase: getting it wrong does not error, it silently returns the wrong rows — the same broader-result-set failure that motivated #302.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { queueQuery } from "./crm-queue-query";

const params = (f: Parameters<typeof queueQuery>[0], limit = 100, cursor?: string) =>
  Object.fromEntries(queueQuery(f, limit, cursor).entries());

describe("queueQuery", () => {
  it("sends plain values for ordinary filters", () => {
    expect(params({ product: "mark8ly", stage: "contacted", owner: "sam" })).toEqual({
      product: "mark8ly", stage: "contacted", owner: "sam", limit: "100",
    });
  });

  it("turns the unassigned-product sentinel into product_unset", () => {
    const out = params({ product: "__unassigned__" });
    expect(out.product_unset).toBe("true");
    expect(out.product).toBeUndefined();
  });

  it("turns the unknown-country sentinel into country_unset", () => {
    const out = params({ country: "__unknown__" });
    expect(out.country_unset).toBe("true");
    expect(out.country).toBeUndefined();
  });

  it("turns the unknown-followers sentinel into followers_unset", () => {
    const out = params({ followers: "__unknown__" });
    expect(out.followers_unset).toBe("true");
    expect(out.followers).toBeUndefined();
  });

  it("never sends an axis and its _unset twin together", () => {
    const out = queueQuery({ product: "__unassigned__" }, 100);
    expect(out.has("product")).toBe(false);
    expect(out.has("product_unset")).toBe(true);
  });

  it("omits absent filters entirely rather than sending empty strings", () => {
    expect(params({})).toEqual({ limit: "100" });
  });

  it("includes the cursor only when one is given", () => {
    expect(params({}, 100, "abc").cursor).toBe("abc");
    expect(params({}, 100).cursor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run lib/crm-queue-query.test.ts`
Expected: FAIL — cannot resolve `./crm-queue-query`.

- [ ] **Step 3: Write the implementation**

```ts
import type { QueueFilter } from "@/lib/db/crm-repo";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, UNKNOWN_FOLLOWERS } from "@/lib/db/crm-filters";

/**
 * The console and the platform API spell "has no value" differently, and this
 * is the only place that knows it.
 *
 * The console puts a SENTINEL IN THE VALUE — `product=__unassigned__` — because
 * its filter state has to survive a round trip through a URL query string that
 * a person can edit. The platform API takes a SEPARATE BOOLEAN — the
 * `<axis>_unset=true` parameters listed in `handler.go`'s `filterParameters` —
 * and answers 422 if an axis arrives with both, naming both keys in `details`.
 *
 * Neither is wrong; they are two encodings of one tri-state. Translating in one
 * function, tested per axis, is the alternative to three call sites each
 * getting it right. Getting it wrong does not raise an error — it drops the
 * filter and returns the whole queue, which looks like a filter that matched a
 * lot. That is the failure #302 exists to refuse, arriving from the client side
 * instead.
 */
const UNSET_SENTINELS: ReadonlyMap<keyof QueueFilter, string> = new Map([
  ["product", UNASSIGNED_PRODUCT],
  ["country", UNKNOWN_COUNTRY],
  ["followers", UNKNOWN_FOLLOWERS],
]);

/** Axes whose value is passed through untouched — no unset spelling exists. */
const PLAIN_AXES: readonly (keyof QueueFilter)[] = ["stage", "owner"];

export function queueQuery(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): URLSearchParams {
  const query = new URLSearchParams();

  for (const [axis, sentinel] of UNSET_SENTINELS) {
    const value = filter[axis];
    if (!value) continue;
    if (value === sentinel) {
      // The twin, never both: sending both is a 422 naming both keys.
      query.set(`${axis}_unset`, "true");
    } else {
      query.set(axis, value);
    }
  }

  for (const axis of PLAIN_AXES) {
    const value = filter[axis];
    if (value) query.set(axis, value);
  }

  query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  return query;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/console && npx vitest run lib/crm-queue-query.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/crm-queue-query.ts apps/console/lib/crm-queue-query.test.ts
git commit -m "feat(console): translate CRM queue filters into the platform API's grammar"
```

---

### Task 3: `platformRequest` must return `meta`, not just `data`

**Files:**
- Modify: `apps/console/lib/platform-api.ts` (the `unwrap` function and `platformRequest`)
- Test: `apps/console/lib/platform-api.test.ts`

**Interfaces:**
- Produces: `platformRequestWithMeta(label, path, init?): Promise<{ data: unknown; meta: unknown }>` — used by Task 4.

**Why this is needed:** `unwrap` currently returns `envelope.data` and discards `envelope.meta`. Tickets never needed it — its summary is a separate resource. The queues carry `total`, `preceding_count` and both cursors in `meta`, and the console's existing pagination UI requires all four. Adding a second entry point rather than changing `platformRequest`'s return type keeps every existing caller untouched.

- [ ] **Step 1: Write the failing test**

Append to `apps/console/lib/platform-api.test.ts`:

```ts
describe("platformRequestWithMeta", () => {
  it("returns data and meta separately", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { opportunities: [] },
          meta: { total: 7, preceding_count: 0, limit: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { platformRequestWithMeta } = await import("./platform-api");
    const result = await platformRequestWithMeta("crm due", "/v1/crm/queues/due?limit=100");

    expect(result.data).toEqual({ opportunities: [] });
    expect(result.meta).toEqual({ total: 7, preceding_count: 0, limit: 100 });
  });

  it("returns an undefined meta when the envelope carries none", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { opportunities: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { platformRequestWithMeta } = await import("./platform-api");
    const result = await platformRequestWithMeta("crm due", "/v1/crm/queues/due");
    expect(result.meta).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts -t platformRequestWithMeta`
Expected: FAIL — `platformRequestWithMeta is not a function`.

- [ ] **Step 3: Implement**

In `apps/console/lib/platform-api.ts`, refactor so the envelope is unwrapped once and both halves are available. Replace the body of `unwrap` with a version that returns both, and keep the old signature as a thin wrapper so no existing caller changes:

```ts
interface Envelope {
  data: unknown;
  meta: unknown;
}

/**
 * Unwrap go-shared's StandardResponse, keeping `meta`.
 *
 * `meta` was previously discarded because tickets did not need it: its summary
 * is a separate resource, per §2. The CRM queues put `total`, `preceding_count`
 * and both cursors there, and the console's pagination controls need all four —
 * so the envelope has to be opened once and handed over whole.
 */
function unwrapEnvelope(label: string, status: number, body: unknown): Envelope {
  if (typeof body !== "object" || body === null) {
    throw new PlatformApiError(`${label}: response was not an object`, status);
  }
  const envelope = body as {
    success?: unknown;
    data?: unknown;
    meta?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (envelope.success === true) {
    return { data: envelope.data, meta: envelope.meta };
  }
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "UNKNOWN";
  const message =
    typeof envelope.error?.message === "string" ? envelope.error.message : "request failed";
  throw new PlatformApiError(`${label}: ${code} — ${message}`, status);
}

function unwrap(label: string, status: number, body: unknown): unknown {
  return unwrapEnvelope(label, status, body).data;
}
```

Then split `platformRequest` so the transport is shared and only the return differs. Find the existing `platformRequest`, rename its body to `platformCall` returning the envelope, and define both public entry points:

```ts
async function platformCall(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<Envelope> {
  // …the existing body of platformRequest, verbatim, except the final line…
  // return unwrap(label, response.status, body);
  return unwrapEnvelope(label, response.status, body);
}

async function platformRequest(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  return (await platformCall(label, path, init)).data;
}

/** As `platformRequest`, but keeps `meta` — pagination lives there. */
export async function platformRequestWithMeta(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<{ data: unknown; meta: unknown }> {
  return platformCall(label, path, init);
}
```

- [ ] **Step 4: Run the whole console test suite**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts`
Expected: PASS — the new tests plus every existing `platformRequest` test unchanged. If any existing test fails, the refactor changed behaviour; fix the refactor, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/platform-api.ts apps/console/lib/platform-api.test.ts
git commit -m "feat(console): keep meta when unwrapping the platform API envelope"
```

---

### Task 4: The dual-path seam

**Files:**
- Create: `apps/console/lib/crm-queues.ts`
- Test: `apps/console/lib/crm-queues.test.ts`

**Interfaces:**
- Consumes: `parseQueuePage` (Task 1), `queueQuery` (Task 2), `platformRequestWithMeta` (Task 3), `platformApiOrigin` from `@/lib/platform-api`, and `dueOpportunities`/`driftingOpportunities`/`setNextAction` from `@/lib/db/crm-repo`.
- Produces: `fetchDueQueue(filter, limit, cursor?)`, `fetchDriftingQueue(filter, staleDays, limit, cursor?)`, `saveNextAction(input)` — used by Task 5.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/crm-repo", () => ({
  dueOpportunities: vi.fn().mockResolvedValue({
    rows: [], total: 1, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
  driftingOpportunities: vi.fn().mockResolvedValue({
    rows: [], total: 2, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
  setNextAction: vi.fn().mockResolvedValue(undefined),
}));

const withMeta = vi.fn();
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: () => process.env.PLATFORM_API_ORIGIN?.trim() || null,
  platformRequestWithMeta: (...args: unknown[]) => withMeta(...args),
}));

describe("crm-queues dual path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PLATFORM_API_ORIGIN;
  });

  it("reads Postgres when PLATFORM_API_ORIGIN is unset", async () => {
    const repo = await import("@/lib/db/crm-repo");
    const { fetchDueQueue } = await import("./crm-queues");
    const page = await fetchDueQueue({ stage: "new" }, 100);
    expect(repo.dueOpportunities).toHaveBeenCalledWith({ stage: "new" }, 100, undefined);
    expect(withMeta).not.toHaveBeenCalled();
    expect(page.total).toBe(1);
  });

  it("calls the platform API when PLATFORM_API_ORIGIN is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({
      data: { opportunities: [] },
      meta: { total: 9, preceding_count: 0 },
    });
    const repo = await import("@/lib/db/crm-repo");
    const { fetchDueQueue } = await import("./crm-queues");
    const page = await fetchDueQueue({ stage: "new" }, 100);
    expect(repo.dueOpportunities).not.toHaveBeenCalled();
    expect(withMeta).toHaveBeenCalledWith("crm due queue", "/v1/crm/queues/due?stage=new&limit=100");
    expect(page.total).toBe(9);
  });

  it("sends stale_days on the drifting queue", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({ data: { opportunities: [] }, meta: {} });
    const { fetchDriftingQueue } = await import("./crm-queues");
    await fetchDriftingQueue({}, 14, 100);
    expect(withMeta).toHaveBeenCalledWith(
      "crm drifting queue",
      "/v1/crm/queues/drifting?limit=100&stale_days=14",
    );
  });

  it("PUTs the next action with a JSON body when the API is on", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({ data: { opportunity: {} }, meta: undefined });
    const { saveNextAction } = await import("./crm-queues");
    await saveNextAction({ opportunityId: "abc", at: null, note: "later", actor: "sam@example.com" });
    expect(withMeta).toHaveBeenCalledWith(
      "crm next action",
      "/v1/crm/opportunities/abc/next-action",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ at: null, note: "later" }),
      }),
    );
  });

  it("falls back to the repo for the next action when the API is off", async () => {
    const repo = await import("@/lib/db/crm-repo");
    const { saveNextAction } = await import("./crm-queues");
    const input = { opportunityId: "abc", at: null, note: "later", actor: "sam@example.com" };
    await saveNextAction(input);
    expect(repo.setNextAction).toHaveBeenCalledWith(input);
    expect(withMeta).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/console && npx vitest run lib/crm-queues.test.ts`
Expected: FAIL — cannot resolve `./crm-queues`.

- [ ] **Step 3: Implement**

```ts
// `server-only`: this module reaches Postgres on one branch and an operator's
// bearer token on the other. A client component importing it must fail the
// build, not ship `pg` to the browser — see #299.
import "server-only";

import { randomUUID } from "node:crypto";
import type { QueueFilter, QueuePage, SetNextActionInput } from "@/lib/db/crm-repo";
import {
  driftingOpportunities,
  dueOpportunities,
  setNextAction,
} from "@/lib/db/crm-repo";
import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";
import { parseQueuePage } from "@/lib/crm-queue-wire";
import { queueQuery } from "@/lib/crm-queue-query";

/**
 * Where the CRM queues get their data.
 *
 * Two backends behind one set of signatures, chosen by `PLATFORM_API_ORIGIN` —
 * the same switch `fetchTickets` uses, and for the same reason: UNSET IS
 * BYTE-FOR-BYTE THE OLD BEHAVIOUR, so this whole phase reverts by removing one
 * variable rather than by reverting code.
 *
 * `crm-repo.ts` is deliberately not modified. It is a database module; teaching
 * it to speak HTTP would put a transport inside the layer whose entire job is
 * SQL, and it is 2,499 lines already. The seam belongs here, one level up,
 * where the pages import from.
 *
 * # A note on cursors, because this is a real behaviour change
 *
 * The two backends mint cursors with DIFFERENT CODECS. `keyset-cursor.ts`
 * encodes `(timestamp, uuid, direction)`; the platform API encodes
 * `{v, d, k}` as base64url and includes the queue's own name so one queue's
 * cursor cannot page the other. Within either backend the cursors are
 * self-consistent, and the console always echoes back whatever it was handed.
 *
 * The seam is a link BOOKMARKED before the cutover and opened after it: the
 * platform API cannot decode a console-minted cursor and answers 400 "the
 * cursor could not be read; start from the first page". That is an honest,
 * actionable refusal rather than wrong rows, which is why it is accepted rather
 * than papered over by teaching either side the other's codec.
 */

export async function fetchDueQueue(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  if (!platformApiOrigin()) {
    return dueOpportunities(filter, limit, cursor);
  }
  const query = queueQuery(filter, limit, cursor);
  const { data, meta } = await platformRequestWithMeta(
    "crm due queue",
    `/v1/crm/queues/due?${query.toString()}`,
  );
  return parseQueuePage(data, meta);
}

export async function fetchDriftingQueue(
  filter: QueueFilter,
  staleDays: number,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  if (!platformApiOrigin()) {
    return driftingOpportunities(filter, staleDays, limit, cursor);
  }
  const query = queueQuery(filter, limit, cursor);
  // Set after the shared parameters so the ordering is stable and the tests can
  // assert on a whole URL rather than parsing it back apart.
  query.set("stale_days", String(staleDays));
  const { data, meta } = await platformRequestWithMeta(
    "crm drifting queue",
    `/v1/crm/queues/drifting?${query.toString()}`,
  );
  return parseQueuePage(data, meta);
}

export async function saveNextAction(input: SetNextActionInput): Promise<void> {
  if (!platformApiOrigin()) {
    return setNextAction(input);
  }
  // `actor` is not sent: the platform API takes the actor from the bearer
  // token's principal and records it in its own audit row. Sending a
  // caller-supplied actor would let the client name someone else.
  await platformRequestWithMeta(
    "crm next action",
    `/v1/crm/opportunities/${encodeURIComponent(input.opportunityId)}/next-action`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        // Scheduling the same next action twice is harmless, but the write is
        // still a write: a retry after a timeout must not produce a second
        // audit row. The key is per attempt, minted here.
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ at: input.at, note: input.note }),
    },
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/console && npx vitest run lib/crm-queues.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/crm-queues.ts apps/console/lib/crm-queues.test.ts
git commit -m "feat(console): a dual-path seam for the CRM queues"
```

---

### Task 5: Point the pages at the seam

**Files:**
- Modify: `apps/console/app/(console)/platform/crm/page.tsx` (the `dueOpportunities`/`driftingOpportunities` imports and their two call sites, ~lines 605-606)
- Modify: `apps/console/app/(console)/platform/crm/[organisation]/actions.ts` (the `setNextAction` import and its call site in `scheduleNextAction`, ~line 146)
- Test: existing `apps/console/app/(console)/platform/crm/page.test.tsx` and `[organisation]/actions.test.ts` must pass with their mocks retargeted.

**Interfaces:**
- Consumes: `fetchDueQueue`, `fetchDriftingQueue`, `saveNextAction` from Task 4.

**Why the tests need retargeting rather than rewriting:** both suites mock the repo functions at the module boundary. Moving the call one module up means the mock must move with it; the assertions themselves do not change, which is the signal that behaviour did not change.

- [ ] **Step 1: Retarget the page test's mock and watch it fail**

In `apps/console/app/(console)/platform/crm/page.test.tsx`, change the mock target from `@/lib/db/crm-repo` to `@/lib/crm-queues` for the two queue functions only, renaming them:

```ts
vi.mock("@/lib/crm-queues", () => ({
  fetchDueQueue: vi.fn().mockResolvedValue({
    rows: [], total: 0, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
  fetchDriftingQueue: vi.fn().mockResolvedValue({
    rows: [], total: 0, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
}));
```

Leave every other mock in that file (`wonWithoutConversion`, and anything else from `crm-repo`) exactly as it is — those functions are not in this phase.

Run: `cd apps/console && npx vitest run "app/(console)/platform/crm/page.test.tsx"`
Expected: FAIL — the page still imports `dueOpportunities` from the repo, so the new mock is unused and the real repo function runs.

- [ ] **Step 2: Update the page**

In `apps/console/app/(console)/platform/crm/page.tsx`, remove `dueOpportunities` and `driftingOpportunities` from the `@/lib/db/crm-repo` import list (keep every other name in it), and add:

```ts
import { fetchDriftingQueue, fetchDueQueue } from "@/lib/crm-queues";
```

Then change the two call sites inside the existing `Promise.allSettled`:

```ts
// was: dueOpportunities(filter, DUE_LIMIT, dueCursor)
fetchDueQueue(filter, DUE_LIMIT, dueCursor),
// was: driftingOpportunities(filter, DRIFT_DAYS, DRIFTING_LIMIT, driftCursor)
fetchDriftingQueue(filter, DRIFT_DAYS, DRIFTING_LIMIT, driftCursor),
```

Keep the `Promise.allSettled` exactly as it is: one queue failing must not blank the other, and that property matters more now that a failure can be an HTTP error rather than a SQL one.

- [ ] **Step 3: Run the page test and watch it pass**

Run: `cd apps/console && npx vitest run "app/(console)/platform/crm/page.test.tsx"`
Expected: PASS, unchanged assertions.

- [ ] **Step 4: Retarget the action test and watch it fail**

In `apps/console/app/(console)/platform/crm/[organisation]/actions.test.ts`, change the `setNextAction` mock from `@/lib/db/crm-repo` to `@/lib/crm-queues` as `saveNextAction`. Leave `advanceStage`, `logActivity` and `linkConversion` mocked where they are — they stay on the repo in this phase.

Run: `cd apps/console && npx vitest run "app/(console)/platform/crm/[organisation]/actions.test.ts"`
Expected: FAIL — `scheduleNextAction` still calls the repo.

- [ ] **Step 5: Update the action**

In `apps/console/app/(console)/platform/crm/[organisation]/actions.ts`, remove `setNextAction` from the `@/lib/db/crm-repo` import (keep the others), add `import { saveNextAction } from "@/lib/crm-queues";`, and change the one call inside `scheduleNextAction` from `setNextAction(input)` to `saveNextAction(input)`. Leave the surrounding `withCrmWrite` wrapper untouched — capability checking and auditing stay where they are.

- [ ] **Step 6: Run both suites and watch them pass**

Run:
```bash
cd apps/console && npx vitest run "app/(console)/platform/crm/page.test.tsx" "app/(console)/platform/crm/[organisation]/actions.test.ts"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "apps/console/app/(console)/platform/crm/page.tsx" \
        "apps/console/app/(console)/platform/crm/[organisation]/actions.ts" \
        "apps/console/app/(console)/platform/crm/page.test.tsx" \
        "apps/console/app/(console)/platform/crm/[organisation]/actions.test.ts"
git commit -m "feat(console): read the CRM queues through the platform API seam"
```

---

### Task 6: Prove the whole console still builds and behaves

**Files:** none created; this task is the gate.

**Why it is a task and not a step:** `tsc` resolves modules but does not bundle them. A `server-only` import reaching a client component type-checks cleanly and fails at build. That is exactly how main broke, and `crm-queues.ts` adds a new `server-only` module imported by a page.

- [ ] **Step 1: Full console test suite**

Run: `cd apps/console && npx vitest run`
Expected: PASS, no failures. Note the count.

- [ ] **Step 2: Typecheck**

Run: `cd apps/console && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: The build — the step that actually catches the bundling mistake**

Run: `cd apps/console && npx next build`
Expected: succeeds. If it fails with a `server-only` or `pg` resolution error, a client component is importing `crm-queues.ts` transitively; find it with the build's own module trace and break the import, do not delete the `server-only` marker.

- [ ] **Step 4: Verify the fallback path is genuinely unchanged**

With `PLATFORM_API_ORIGIN` unset, the queue functions must call the repo exactly as before. This is asserted by the Task 4 tests; confirm they ran:

Run: `cd apps/console && npx vitest run lib/crm-queues.test.ts --reporter verbose`
Expected: the two "when PLATFORM_API_ORIGIN is unset" / "falls back" tests both listed as passing.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git push -u origin feat/crm-queues-console-cutover
```

PR body must state: the switch is `PLATFORM_API_ORIGIN` (already set in production, so **this PR turns the CRM queues on at merge** — unlike the tickets migration, which merged switched off); that #301 parity is preserved deliberately; and that pre-cutover bookmarked cursor links will answer 400 with "start from the first page".

---

## Post-merge verification (not a task — do this against the live console)

1. Load `/platform/crm`. Both queues render.
2. Compare row counts against the pre-merge screenshot, or against a direct SQL count. Parity means the same rows in the same order.
3. Apply each filter axis in turn — product, stage, owner, country, followers — and confirm the row set narrows. **Then apply the unassigned/unknown variants**, which is where Task 2's translation would fail silently.
4. Page forward and back; confirm no repeated or skipped row at the boundary.
5. Schedule a next action; confirm it persists and that an audit row appears with the operator's email.
6. Check `platform-api` logs for 4xx: a 422 naming an axis means the filter translation is wrong; a 400 naming `accepted` means an unknown parameter is being sent.
