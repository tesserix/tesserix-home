# Console Notification Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #180 — a notification bell in the console: unread count, a panel of recent items, each linking to the ticket that needs a human.

**Architecture:** Notifications are **derived, never stored** — a new ticket or a merchant reply, read straight from `platform_tickets` / `platform_ticket_replies`. The only new state is one row per operator holding a last-seen timestamp, from which "unread" is computed. This requires the console to talk to `tesserix-postgres` directly for the first time, mirroring `charts/apps/company`'s existing credential wiring. Polling via SWR; no push.

**Tech Stack:** Next.js 16 App Router (route handler + client component), `pg`, SWR, `@tesserix/platform-auth`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-16-console-notification-bell-design.md` — read it; every decision below is argued there (D1–D9).

**Branch:** `feat/console-notification-bell`, stacked on `feat/console-ticket-detail` (PR #181) because every notification links to `/platform/tickets/[id]`, which that branch builds, and because it reuses `checkOperatorCapability` from it. Open the PR with `--base feat/console-ticket-detail`; GitHub retargets to main when #181 merges.

## Global Constraints

- Every verb asserts a capability, in the same change that adds it. The bell's verb is **mark read** and it asserts **`read`** — per-operator attention state is not a privileged action (spec D5).
- Notifications are derived from existing rows only. No events table, no writer, nothing that fires on a schedule regardless of whether something changed.
- Unread is **0** for an operator with no last-seen row; the feed still lists items (spec D3). Reads never write.
- Feed window: newest **20** events within **14** days.
- The bell degrades quiet: with `TESSERIX_DB_*` unset the route answers **501** and the bell renders disabled, never breaking the sidebar on every page (spec D8). 501 is the estate's existing "data plane parked" signal — see `NOT_IMPLEMENTED` in `apps/console/lib/triage.ts`.
- The console middleware matcher covers `/api/*`, so an expired session answers a poll with a redirect, not JSON. The client treats non-JSON or redirected responses as unavailable and stops rather than hammering.
- Reject malformed rows rather than coercing them, matching `lib/tickets.ts`.
- Immutability; no `console.log`; files well under 800 lines; explicit types on exports.
- Single-line conventional commits, no signatures, no body.
- Verification per task from `apps/console/`: `npm run test:unit`; at the end also `npm run typecheck && npm run lint && npm run build`.
- Work in the worktree at `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/.claude/worktrees/m0-foundation` using **absolute paths** — the shell resets its cwd to a stale checkout between commands.

### Schema facts (verified against `apps/web/db/migrations/0002_platform_comms.sql`)

- `platform_tickets(id uuid, product_id text, ticket_number varchar(20), subject varchar(300), status, priority, submitted_by_name varchar(200), created_at timestamptz, …)`
- `platform_ticket_replies(id uuid, ticket_id uuid → tickets, author_type varchar(20) CHECK IN ('merchant','platform_admin'), author_name varchar(200), content text, created_at timestamptz)`
- Existing indexes: `pt_open_idx (created_at DESC) WHERE status IN ('open','in_progress')`, `ptr_ticket_idx (ticket_id, created_at)`. Nothing supports "recent merchant replies across all tickets" — Task 1 adds it.
- Highest existing migration is `0016_seed_dwellm8_app.sql`; the next number is **0017**.

---

### Task 1: Migration + the console's database connection

**Files:**
- Create: `apps/web/db/migrations/0017_console_notification_reads.sql`
- Create: `apps/console/lib/db/tesserix.ts`
- Test: `apps/console/lib/db/tesserix.test.ts`
- Modify: `apps/console/package.json` (add `pg`, `@types/pg`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (Tasks 2 and 3 rely on these exact names):
  - `isDatabaseConfigured(): boolean`
  - `tesserixQuery<R>(sql: string, params?: readonly unknown[]): Promise<R[]>` — returns `result.rows`, not the pg result

The migration lives in `apps/web/db/migrations/` deliberately: one database, one `schema_migrations` ledger, one runner (`apps/web/scripts/db-migrate.mjs`). Two runners against one integer-versioned ledger is how versions collide (spec D9).

- [ ] **Step 1: Write the migration**

`apps/web/db/migrations/0017_console_notification_reads.sql`:

```sql
-- 0017_console_notification_reads.sql
--
-- Per-operator "last time I looked at the bell". The console derives unread
-- from this: anything newer than your last visit. One row per operator, so it
-- does not grow with items × operators the way read receipts would — and it
-- follows the operator across devices, which a cookie would not.
--
-- Deliberately NOT a notifications table. A notification here is a ticket or a
-- merchant reply that already exists; storing a copy would let the copy drift
-- from the thing it describes.

CREATE TABLE console_notification_reads (
  -- The session `sub` — a Zitadel subject, an opaque string and NOT a uuid.
  -- text for the same reason migration 0003 made author_user_id text.
  user_id      text        PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The bell's second query is "merchant replies across ALL tickets, newest
-- first, within a window". ptr_ticket_idx is (ticket_id, created_at) and
-- cannot serve it. Partial, because platform_admin replies are never a
-- notification — an operator does not need telling that they replied.
CREATE INDEX ptr_merchant_recent_idx
  ON platform_ticket_replies (created_at DESC)
  WHERE author_type = 'merchant';
```

Do **not** run this against any database. Applying it is an operator step recorded in the PR body.

- [ ] **Step 2: Add the dependency**

From the repo root: `pnpm --filter console add pg && pnpm --filter console add -D @types/pg`

Confirm `apps/console/package.json` gained both and that `pnpm install` leaves the lockfile consistent.

- [ ] **Step 3: Write the failing test**

`apps/console/lib/db/tesserix.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured } from "./tesserix";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDatabaseConfigured", () => {
  it("is false when the host is unset", () => {
    // The window between this shipping and the k8s change deploying. The bell
    // must read as unavailable, not crash the sidebar on every page.
    vi.stubEnv("TESSERIX_DB_HOST", "");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "p");
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("is false when only the password is missing", () => {
    vi.stubEnv("TESSERIX_DB_HOST", "h");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "");
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("is true when host, user and password are all present", () => {
    vi.stubEnv("TESSERIX_DB_HOST", "h");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "p");
    expect(isDatabaseConfigured()).toBe(true);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

From `apps/console/`: `npm run test:unit -- lib/db/tesserix.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement `apps/console/lib/db/tesserix.ts`**

Note `isDatabaseConfigured` reads `process.env` at call time, not module load — `vi.stubEnv` after import must be observable, and the pod's env is fixed anyway.

```ts
import { Pool } from "pg";
import type { QueryResultRow } from "pg";

/**
 * The console's connection to tesserix-postgres.
 *
 * Mirrors apps/web/lib/db/tesserix.ts, which reads the same database with the
 * same credentials (the tesserix-postgres-tesserix-admin Secret, already
 * present in the namespace). Duplicated rather than shared because the two
 * apps are separately deployed processes with separate lifetimes; a shared
 * package would couple their pool tuning and their restarts.
 *
 * This is the console reading its OWN store — tesserix-postgres is
 * platform-owned, not a product database, so it does not couple a product to
 * the platform's availability.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Is the connection wired up at all?
 *
 * Read at call time, not at import: this ships BEFORE the chart change that
 * supplies the variables, and for that window every consumer must be able to
 * ask and get a truthful "no" rather than throwing on import and taking the
 * whole sidebar down with it.
 */
export function isDatabaseConfigured(): boolean {
  return Boolean(
    env("TESSERIX_DB_HOST") &&
      env("TESSERIX_DB_USER") &&
      env("TESSERIX_DB_PASSWORD"),
  );
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  if (!isDatabaseConfigured()) {
    throw new Error(
      "tesserix DB env not set: TESSERIX_DB_HOST/USER/PASSWORD required",
    );
  }
  pool = new Pool({
    host: env("TESSERIX_DB_HOST"),
    port: Number(env("TESSERIX_DB_PORT") ?? 5432),
    database: env("TESSERIX_DB_NAME") ?? "tesserix_admin",
    user: env("TESSERIX_DB_USER"),
    password: env("TESSERIX_DB_PASSWORD"),
    // CNPG self-signs and rotates internally; pinning the CA would force
    // rebuilds on every rotation. In-cluster connection, no MITM exposure.
    ssl: { rejectUnauthorized: false },
    // The console polls; it does not batch. Two connections is plenty and
    // leaves headroom on a single-instance database shared with apps/web.
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An unhandled 'error' event on an idle client crashes the process. CNPG
  // recycles connections during failover, so this fires in normal operation.
  pool.on("error", () => {});
  return pool;
}

export async function tesserixQuery<R extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const result = await getPool().query<R>(sql, params as unknown[]);
  return result.rows;
}
```

- [ ] **Step 6: Run the test — it must pass**

From `apps/console/`: `npm run test:unit -- lib/db/tesserix.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/db/migrations/0017_console_notification_reads.sql apps/console/lib/db apps/console/package.json pnpm-lock.yaml
git commit -m "feat(console): connect the console to tesserix-postgres for notification state"
```

---

### Task 2: The feed — repository queries and pure derivation

**Files:**
- Create: `apps/console/lib/db/notifications-repo.ts`
- Create: `apps/console/lib/notifications.ts`
- Test: `apps/console/lib/notifications.test.ts`

**Interfaces:**
- Consumes: `tesserixQuery` (Task 1).
- Produces (Task 3 relies on these exact names):
  - `lib/notifications.ts`: `type NotificationKind = "ticket_created" | "merchant_reply"`; `NotificationItem`; `NotificationFeed`; `FEED_LIMIT = 20`; `FEED_WINDOW_DAYS = 14`; `toTicketEvent(row): NotificationItem`; `toReplyEvent(row): NotificationItem`; `mergeEvents(a: readonly NotificationItem[], b: readonly NotificationItem[], limit: number): NotificationItem[]`; `countUnread(items, lastSeenAt: string | null): number`
  - `lib/db/notifications-repo.ts`: `recentTicketRows(sinceIso, limit)`, `recentMerchantReplyRows(sinceIso, limit)`, `readLastSeenAt(userId)`, `writeLastSeenAt(userId, atIso)`

The split mirrors the codebase's existing shape: SQL in `lib/db`, types and derivation in `lib/`, so the logic is testable without a database.

- [ ] **Step 1: Write the failing tests**

`apps/console/lib/notifications.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  countUnread,
  mergeEvents,
  toReplyEvent,
  toTicketEvent,
  type NotificationItem,
} from "./notifications";

const TICKET_ROW = {
  id: "5f0b2c34-0000-0000-0000-000000000000",
  product_id: "mark8ly",
  ticket_number: "M8-1042",
  subject: "Payout missing",
  submitted_by_name: "Asha Pillai",
  created_at: "2026-08-14T04:00:00.000Z",
};

const REPLY_ROW = {
  id: "77770000-0000-0000-0000-000000000000",
  ticket_id: "5f0b2c34-0000-0000-0000-000000000000",
  author_name: "Asha Pillai",
  created_at: "2026-08-15T04:00:00.000Z",
  ticket_number: "M8-1042",
  product_id: "mark8ly",
  subject: "Payout missing",
};

function item(at: string, id = at): NotificationItem {
  return {
    id,
    kind: "ticket_created",
    ticketId: "t",
    ticketNumber: "M8-1",
    productId: "mark8ly",
    subject: "s",
    actor: "a",
    at,
  };
}

describe("toTicketEvent", () => {
  it("links to the ticket by uuid, not by number", () => {
    // The detail route keys on the uuid; the number is for humans only.
    const e = toTicketEvent(TICKET_ROW);
    expect(e.ticketId).toBe(TICKET_ROW.id);
    expect(e.ticketNumber).toBe("M8-1042");
    expect(e.kind).toBe("ticket_created");
    expect(e.actor).toBe("Asha Pillai");
    expect(e.at).toBe(TICKET_ROW.created_at);
  });

  it("gives the event an id distinct from the reply with the same row id", () => {
    // Both feeds are merged into one list; a bare row id could collide.
    const t = toTicketEvent(TICKET_ROW);
    const r = toReplyEvent({ ...REPLY_ROW, id: TICKET_ROW.id });
    expect(t.id).not.toBe(r.id);
  });
});

describe("toReplyEvent", () => {
  it("points at the parent ticket, not the reply", () => {
    const e = toReplyEvent(REPLY_ROW);
    expect(e.ticketId).toBe(REPLY_ROW.ticket_id);
    expect(e.kind).toBe("merchant_reply");
    expect(e.actor).toBe("Asha Pillai");
  });
});

describe("mergeEvents", () => {
  it("interleaves both sources newest first", () => {
    const merged = mergeEvents(
      [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
      [item("2026-08-12T00:00:00.000Z")],
      10,
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ]);
  });

  it("truncates to the limit after sorting, keeping the newest", () => {
    const merged = mergeEvents(
      [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
      [item("2026-08-12T00:00:00.000Z")],
      2,
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    ]);
  });

  it("does not mutate its inputs", () => {
    const a = [item("2026-08-10T00:00:00.000Z")];
    const frozen = Object.freeze([...a]);
    expect(() => mergeEvents(frozen, [], 5)).not.toThrow();
  });
});

describe("countUnread", () => {
  it("is zero for an operator who has never opened the panel", () => {
    // Not "everything since the beginning of time" — a bell that opens with
    // 500 in it on day one is the bell nobody reads.
    expect(countUnread([item("2026-08-14T00:00:00.000Z")], null)).toBe(0);
  });

  it("counts only events strictly newer than last seen", () => {
    const items = [
      item("2026-08-16T00:00:00.000Z"),
      item("2026-08-15T00:00:00.000Z"),
      item("2026-08-14T00:00:00.000Z"),
    ];
    expect(countUnread(items, "2026-08-15T00:00:00.000Z")).toBe(1);
  });

  it("counts nothing when last seen is newer than every event", () => {
    expect(countUnread([item("2026-08-14T00:00:00.000Z")], "2026-08-20T00:00:00.000Z")).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- lib/notifications.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `apps/console/lib/notifications.ts`**

```ts
/**
 * What the bell shows.
 *
 * A notification is DERIVED — a ticket that arrived or a merchant who replied,
 * read from the rows themselves. There is no notifications table and no
 * writer, so an item cannot drift from the thing it describes and cannot
 * outlive it. Everything here links to a ticket a human can open.
 */

export type NotificationKind = "ticket_created" | "merchant_reply";

export interface NotificationItem {
  /** `${kind}:${row id}` — the merged list holds both kinds, and a bare row
   *  id could collide across the two tables. */
  readonly id: string;
  readonly kind: NotificationKind;
  /** The ticket's uuid. The detail route keys on this, never the number. */
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly productId: string;
  readonly subject: string;
  readonly actor: string;
  readonly at: string;
}

export interface NotificationFeed {
  readonly items: readonly NotificationItem[];
  readonly unread: number;
  readonly lastSeenAt: string | null;
}

export const FEED_LIMIT = 20;
export const FEED_WINDOW_DAYS = 14;

export interface TicketEventRow {
  readonly id: string;
  readonly product_id: string;
  readonly ticket_number: string;
  readonly subject: string;
  readonly submitted_by_name: string;
  readonly created_at: string;
}

export interface ReplyEventRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly author_name: string;
  readonly created_at: string;
  readonly ticket_number: string;
  readonly product_id: string;
  readonly subject: string;
}

export function toTicketEvent(row: TicketEventRow): NotificationItem {
  return {
    id: `ticket_created:${row.id}`,
    kind: "ticket_created",
    ticketId: row.id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.submitted_by_name,
    at: row.created_at,
  };
}

export function toReplyEvent(row: ReplyEventRow): NotificationItem {
  return {
    id: `merchant_reply:${row.id}`,
    kind: "merchant_reply",
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.author_name,
    at: row.created_at,
  };
}

/** Newest first, then truncated — truncating before sorting would drop new
 *  events from whichever source happened to be longer. */
export function mergeEvents(
  a: readonly NotificationItem[],
  b: readonly NotificationItem[],
  limit: number,
): NotificationItem[] {
  return [...a, ...b]
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    .slice(0, limit);
}

/**
 * Unread is derived, never stored.
 *
 * `null` last-seen means the operator has never opened the panel, and that
 * reads as ZERO rather than as the entire window. The alternative ships a bell
 * with every ticket ever in it on the day it launches, which trains everyone
 * to ignore it.
 */
export function countUnread(
  items: readonly NotificationItem[],
  lastSeenAt: string | null,
): number {
  if (!lastSeenAt) return 0;
  return items.filter((item) => item.at > lastSeenAt).length;
}
```

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- lib/notifications.test.ts` → PASS.

- [ ] **Step 5: Implement `apps/console/lib/db/notifications-repo.ts`**

No unit tests: this file is SQL strings and a thin call to `tesserixQuery`. Its correctness is in the SQL, which a mock cannot check — Task 6's smoke is where it is really exercised.

```ts
import { tesserixQuery } from "./tesserix";
import type { ReplyEventRow, TicketEventRow } from "../notifications";

/**
 * The bell's reads and its one write.
 *
 * Both feed queries are bounded by a window AND a limit: the window keeps the
 * scan small, the limit keeps the panel scannable.
 */

export async function recentTicketRows(
  sinceIso: string,
  limit: number,
): Promise<TicketEventRow[]> {
  return tesserixQuery<TicketEventRow>(
    `SELECT id::text, product_id, ticket_number, subject,
            submitted_by_name, created_at
       FROM platform_tickets
      WHERE created_at > $1::timestamptz
      ORDER BY created_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  );
}

export async function recentMerchantReplyRows(
  sinceIso: string,
  limit: number,
): Promise<ReplyEventRow[]> {
  // Merchant replies only. An operator does not need telling that they
  // themselves replied — and ptr_merchant_recent_idx is partial on exactly
  // this predicate.
  return tesserixQuery<ReplyEventRow>(
    `SELECT r.id::text, r.ticket_id::text, r.author_name, r.created_at,
            t.ticket_number, t.product_id, t.subject
       FROM platform_ticket_replies r
       JOIN platform_tickets t ON t.id = r.ticket_id
      WHERE r.author_type = 'merchant'
        AND r.created_at > $1::timestamptz
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  );
}

export async function readLastSeenAt(userId: string): Promise<string | null> {
  const rows = await tesserixQuery<{ last_seen_at: string }>(
    `SELECT last_seen_at FROM console_notification_reads WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.last_seen_at ?? null;
}

export async function writeLastSeenAt(
  userId: string,
  atIso: string,
): Promise<void> {
  await tesserixQuery(
    `INSERT INTO console_notification_reads (user_id, last_seen_at)
     VALUES ($1, $2::timestamptz)
     ON CONFLICT (user_id)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, updated_at = now()`,
    [userId, atIso],
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/console/lib/notifications.ts apps/console/lib/notifications.test.ts apps/console/lib/db/notifications-repo.ts
git commit -m "feat(console): derive the notification feed from tickets and merchant replies"
```

---

### Task 3: The API route — GET the feed, POST mark-read

**Files:**
- Create: `apps/console/app/api/notifications/route.ts`
- Test: `apps/console/app/api/notifications/route.test.ts`

**Interfaces:**
- Consumes: `isDatabaseConfigured` (T1), everything from T2, `checkOperatorCapability` from `@/lib/auth/operator` (exists on the base branch), `getCurrentSession` from `@tesserix/platform-auth`.
- Produces: `GET` → `200 { items, unread, lastSeenAt }` | `501 { error: "not_configured" }` | `500 { error: "unavailable" }`; `POST` → `200 { ok: true, lastSeenAt }` | `403 { error: "forbidden" }` | `501`.

Both verbs assert `read`. Middleware already gates the path; the handler asserts anyway, because a surface that depends on routing for its authorization stops being safe the moment the matcher changes.

- [ ] **Step 1: Write the failing tests**

`apps/console/app/api/notifications/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/notifications-repo", () => ({
  recentTicketRows: vi.fn(async () => []),
  recentMerchantReplyRows: vi.fn(async () => []),
  readLastSeenAt: vi.fn(async () => null),
  writeLastSeenAt: vi.fn(async () => {}),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
  writeLastSeenAt,
} from "@/lib/db/notifications-repo";
import { GET, POST } from "./route";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "op@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(recentTicketRows).mockResolvedValue([]);
  vi.mocked(recentMerchantReplyRows).mockResolvedValue([]);
  vi.mocked(readLastSeenAt).mockResolvedValue(null);
});

describe("GET /api/notifications", () => {
  it("returns the merged feed with a derived unread count", async () => {
    signIn(["read"]);
    vi.mocked(readLastSeenAt).mockResolvedValue("2026-08-15T00:00:00.000Z");
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha",
        created_at: "2026-08-16T00:00:00.000Z",
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ticketId).toBe("5f0b2c34-0000-0000-0000-000000000000");
    expect(body.unread).toBe(1);
  });

  it("answers 501 when the database is not wired up yet", async () => {
    // The window before the chart change deploys. 501 is the estate's
    // "data plane parked" signal, distinct from a real failure.
    signIn(["read"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(501);
    expect(recentTicketRows).not.toHaveBeenCalled();
  });

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(recentTicketRows).not.toHaveBeenCalled();
  });

  it("answers 500 without leaking the driver error when a query fails", async () => {
    signIn(["read"]);
    vi.mocked(recentTicketRows).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("password");
  });
});

describe("POST /api/notifications", () => {
  it("writes last-seen and returns it", async () => {
    signIn(["read"]);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(writeLastSeenAt).toHaveBeenCalledWith("sub-1", body.lastSeenAt);
    expect(body.ok).toBe(true);
  });

  it("refuses without the read capability and writes nothing", async () => {
    signIn([]);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(writeLastSeenAt).not.toHaveBeenCalled();
  });

  it("answers 501 rather than writing when the database is not wired up", async () => {
    signIn(["read"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await POST();
    expect(res.status).toBe(501);
    expect(writeLastSeenAt).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- app/api/notifications`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Implement `apps/console/app/api/notifications/route.ts`**

```ts
import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
  writeLastSeenAt,
} from "@/lib/db/notifications-repo";
import {
  FEED_LIMIT,
  FEED_WINDOW_DAYS,
  countUnread,
  mergeEvents,
  toReplyEvent,
  toTicketEvent,
} from "@/lib/notifications";

/**
 * The bell's endpoint. GET reads the feed, POST marks it seen.
 *
 * Both assert `read`. The middleware matcher already covers /api/*, but a
 * surface that leans on routing for its authorization stops being safe the
 * moment the matcher changes — and this one writes.
 */

// Never cached: the whole point is what changed in the last minute.
export const dynamic = "force-dynamic";

function windowStart(now: Date): string {
  return new Date(
    now.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

async function authorize(): Promise<{ sub: string } | NextResponse> {
  const session = await getCurrentSession();
  try {
    checkOperatorCapability(session, "read");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  // checkOperatorCapability refuses a null session, so this is non-null here.
  return { sub: session!.sub };
}

export async function GET(): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    const since = windowStart(new Date());
    const [ticketRows, replyRows, lastSeenAt] = await Promise.all([
      recentTicketRows(since, FEED_LIMIT),
      recentMerchantReplyRows(since, FEED_LIMIT),
      readLastSeenAt(auth.sub),
    ]);
    const items = mergeEvents(
      ticketRows.map(toTicketEvent),
      replyRows.map(toReplyEvent),
      FEED_LIMIT,
    );
    return NextResponse.json({
      items,
      unread: countUnread(items, lastSeenAt),
      lastSeenAt,
    });
  } catch {
    // Deliberately not the driver's message: it carries the connection string
    // and the role name. The operator gets a state, the detail goes nowhere.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const lastSeenAt = new Date().toISOString();
  try {
    await writeLastSeenAt(auth.sub, lastSeenAt);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lastSeenAt });
}
```

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- app/api/notifications` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/app/api/notifications
git commit -m "feat(console): notification feed endpoint asserting read on both verbs"
```

---

### Task 4: The bell and its panel

**Files:**
- Create: `apps/console/components/nav/notification-bell.tsx`
- Modify: `apps/console/components/nav/sidebar.tsx` (add a footer region)
- Test: `apps/console/components/nav/notification-bell.render.test.tsx`

**Interfaces:**
- Consumes: the route from Task 3 over HTTP; `NotificationItem` type from `@/lib/notifications`.
- Produces: `<NotificationBell />`, rendered in the sidebar footer.

The console has no header — the shell is a sidebar plus a main region (spec D7). The bell goes in a new sidebar footer rather than a header strip invented to hold one control.

- [ ] **Step 1: Write the failing render tests**

`apps/console/components/nav/notification-bell.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

function mockFeed(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ITEM = {
  id: "merchant_reply:1",
  kind: "merchant_reply",
  ticketId: "5f0b2c34-0000-0000-0000-000000000000",
  ticketNumber: "M8-1042",
  productId: "mark8ly",
  subject: "Payout missing",
  actor: "Asha Pillai",
  at: "2026-08-16T00:00:00.000Z",
};

describe("NotificationBell", () => {
  it("shows the unread count in the button's accessible name", async () => {
    mockFeed({ items: [ITEM], unread: 1, lastSeenAt: null });
    render(<NotificationBell />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /1 unread/i })).toBeInTheDocument(),
    );
  });

  it("links each item to the ticket by uuid", async () => {
    mockFeed({ items: [ITEM], unread: 1, lastSeenAt: null });
    render(<NotificationBell />);
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole("button", { name: /unread/i }));
    await user.click(screen.getByRole("button", { name: /unread/i }));
    const link = await screen.findByRole("link", { name: /M8-1042/ });
    expect(link).toHaveAttribute(
      "href",
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("says nothing is waiting when the feed is empty", async () => {
    mockFeed({ items: [], unread: 0, lastSeenAt: "2026-08-16T00:00:00.000Z" });
    render(<NotificationBell />);
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole("button"));
    await user.click(screen.getByRole("button"));
    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it("renders quiet and disabled when the data plane is parked", async () => {
    // 501 — the window before the chart change deploys. It must not read as
    // a failure, and it must not keep retrying.
    mockFeed({ error: "not_configured" }, 501);
    render(<NotificationBell />);
    await waitFor(() =>
      expect(screen.getByRole("button")).toBeDisabled(),
    );
  });

  it("treats a redirect to login as unavailable rather than as data", async () => {
    // The middleware matcher covers /api/*, so an expired session answers a
    // poll with HTML, not JSON.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><html><body>login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
  });
});
```

If `@testing-library/user-event` is not already a devDependency of `apps/console`, add it (`pnpm --filter console add -D @testing-library/user-event`) — or, if you prefer not to add a dependency, drive the clicks with `fireEvent` from `@testing-library/react` and say so in your report.

- [ ] **Step 2: Run and watch it fail**

From `apps/console/`: `npm run test:unit -- notification-bell`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the bell**

Before writing, check what `@tesserix/web` actually exports for a popover — `grep -o 'Popover[A-Za-z]*' apps/console/node_modules/@tesserix/web/dist/index.d.ts | sort -u`. If a Popover exists, use it. If not, render the panel as an absolutely-positioned `div` with `role="dialog"`, closing on Escape and on outside click. Say which you used in your report.

Requirements the tests pin, plus these:

- Poll with SWR at `refreshInterval: 60_000`. The console is low-traffic; realtime waits for a reason.
- The fetcher must resolve to an "unavailable" marker rather than throwing on: a non-2xx status, a `content-type` that is not JSON, or a body that does not parse. On unavailable, stop polling (`refreshInterval: 0` for that state or `shouldRetryOnError: false`) — a bell that hammers a parked endpoint every 60s is noise in the logs and load on the pod.
- The button's accessible name carries the count: `aria-label={unread > 0 ? \`Notifications, ${unread} unread\` : "Notifications"}`. The badge itself is `aria-hidden`, so the count is announced once, not twice.
- Display cap: show `9+` above nine, but the accessible name states the real number.
- Opening the panel POSTs to `/api/notifications` and then revalidates, so the badge clears. A failed POST leaves the badge alone and does not surface an error — the operator's attention state failing to save is not worth interrupting them for. (State this in a comment; it is a deliberate choice, not an oversight.)
- Each item renders `ticketNumber`, `subject`, the actor, and a relative time; the whole row is one link to `/platform/tickets/${ticketId}`.
- `kind` decides the leading phrasing: `ticket_created` → "New ticket"; `merchant_reply` → "{actor} replied".
- Honour `prefers-reduced-motion` if you animate the panel at all; prefer not animating.

- [ ] **Step 4: Run — it must pass**

`npm run test:unit -- notification-bell` → PASS.

- [ ] **Step 5: Wire it into the sidebar**

In `apps/console/components/nav/sidebar.tsx`, add a footer region below the `<nav>` inside the existing flex column:

```tsx
      <div className="border-t border-sidebar-border p-3">
        <NotificationBell />
      </div>
```

The sidebar is already a `flex h-full w-56 flex-col`, and `<nav>` already carries `flex-1`, so the footer sits at the bottom without further layout changes. Run the existing `sidebar.render.test.tsx` — it must still pass. If it asserts on the sidebar's structure in a way the footer breaks, fix the test only if the assertion is genuinely about the old structure, and say so in your report.

- [ ] **Step 6: Full gate**

From `apps/console/`: `npm run test:unit && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/console/components/nav
git commit -m "feat(console): notification bell in the sidebar footer"
```

---

### Task 5: Wire the credentials in tesserix-k8s

**Files (different repo — `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s`):**
- Modify: `charts/apps/console/values.yaml`
- Modify: `charts/apps/console/templates/deployment.yaml`
- Modify: `charts/apps/console/Chart.yaml` (version bump)

`tesserix-k8s` auto-syncs to PRODUCTION. **PR only — never commit to main.** Squash-only. Do not merge; Mahesh merges.

- [ ] **Step 1: Branch**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
git fetch origin && git checkout -b feat/console-db-access origin/main
```

- [ ] **Step 2: Add the database block to `charts/apps/console/values.yaml`**

Mirror `charts/apps/company/values.yaml`'s `database.tesserix` block exactly — same host, port, name and `secretName`. The Secret `tesserix-postgres-tesserix-admin` already exists in the `tesserix` namespace (ESO-synced for the company deployment); the console mounts the same one, so there is no new GCP Secret Manager entry and nothing to provision.

```yaml
# tesserix-postgres — the console's own store.
#
# Same cluster, same database and the SAME Secret the company deployment reads
# (charts/apps/company/values.yaml). Nothing new is provisioned here: the
# console is a second reader of a store it co-owns, not a new tenant of it.
#
# Used for the notification bell's per-operator last-seen timestamp, and for
# reading the ticket/reply rows the bell derives its feed from. Everything else
# the console shows still comes through the web app's admin API.
#
# .enabled gates the env block, so the chart still renders where the Secret is
# absent — and the console degrades to a quiet, disabled bell rather than
# failing to start.
database:
  tesserix:
    enabled: true
    host: tesserix-postgres-rw.tesserix.svc.cluster.local
    port: 5432
    name: tesserix_admin
    secretName: tesserix-postgres-tesserix-admin
```

No NetworkPolicy change is needed: `tesserix-postgres` runs in the `tesserix` namespace, and `charts/apps/console/templates/network-policy.yaml`'s egress rule already permits the whole namespace. Verify that is still true before concluding it, and say so in your report.

- [ ] **Step 3: Add the env wiring to `charts/apps/console/templates/deployment.yaml`**

Copy the shape from `charts/apps/company/templates/deployment.yaml` lines ~81–99 — static host/port/name from values, user and password from the Secret:

```yaml
            {{- if .Values.database.tesserix.enabled }}
            # tesserix-postgres — notification state + the bell's feed.
            # Host/port/name are static; user+password come from the
            # tesserix-postgres-tesserix-admin Secret synced by ESO.
            - name: TESSERIX_DB_HOST
              value: {{ .Values.database.tesserix.host | quote }}
            - name: TESSERIX_DB_PORT
              value: {{ .Values.database.tesserix.port | quote }}
            - name: TESSERIX_DB_NAME
              value: {{ .Values.database.tesserix.name | quote }}
            - name: TESSERIX_DB_USER
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.database.tesserix.secretName | quote }}
                  key: username
            - name: TESSERIX_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.database.tesserix.secretName | quote }}
                  key: password
            {{- end }}
```

Place it alongside the other `env:` entries in the console container. Match the file's existing indentation exactly.

- [ ] **Step 4: Bump the chart version and render it**

Bump `version:` in `charts/apps/console/Chart.yaml` (patch). Then:

```bash
helm template console charts/apps/console --values charts/apps/console/values.yaml | grep -A 3 TESSERIX_DB_HOST
helm lint charts/apps/console
```

Both must succeed, and the rendered Deployment must show all five variables. Paste the rendered block into your report.

- [ ] **Step 5: Commit and push (do NOT merge)**

```bash
git add charts/apps/console
git commit -m "feat(console): give the console its own tesserix-postgres credentials"
git push -u origin feat/console-db-access
```

Do not open the PR yourself — report that the branch is pushed and let the controller open it.

---

### Task 6: Build and verify

- [ ] **Step 1: Build**

From `apps/console/`: `npm run build`. It must succeed, and the route list must include `/api/notifications`. Note that `pg` is a Node-only dependency — if the build complains about it in an edge/browser bundle, the fix is that the route handler must not be imported by any client component (the bell talks to it over HTTP only). Report the route table lines.

- [ ] **Step 2: Smoke what can be smoked locally**

The console dev server on :3003 with no `TESSERIX_DB_*` set is exactly the degraded case. Start it, request `/api/notifications`, and confirm it answers **501** (or a login redirect if unauthenticated — say which you saw). Kill the server afterwards. Do not spend more than ~5 minutes.

Anything needing a real session, a real database or seeded rows is **not verifiable locally** — record it rather than forcing it. In particular the SQL in `notifications-repo.ts` is unexercised by any test; say so plainly.

- [ ] **Step 3: Commit any fix the build surfaced**, single-line message. If nothing needed fixing, make no commit.
