import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogSource } from "@/lib/billing/source-policy";

/**
 * Integration coverage for `0038_publish_operations.sql` and the repo
 * functions built on top of it (`publish-repo.ts`) — the same pglite
 * discipline `publish-repo.integration.test.ts` and
 * `plan-catalog-revisions.integration.test.ts` use, and for the identical
 * reason: a CHECK constraint is a claim about what the ENGINE refuses, and
 * only a real database proves it.
 *
 * Two groups of tests:
 *   - "schema constraints" inserts raw rows to prove the CHECKs in 0038
 *     refuse what the executor (Task 6) must never be able to write.
 *   - "publish-repo.ts operations" exercises the write/read functions this
 *     task adds, through the same `tesserixTx` mock every other `lib/db`
 *     integration test uses.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const {
  startPublishAttempt,
  finishPublishAttempt,
  publishAttemptById,
  latestPublishAttempt,
  recordOperation,
  completeOperation,
  operationsForAttempt,
  archivedStripePriceIds,
} = await import("./publish-repo");

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
  "0036_parity_runs_clean_names_publication.sql",
  "0037_publish_catalog_to_live.sql",
  "0038_publish_operations.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

const BASELINE_REVISION_ID = "00000000-0000-0000-0000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // `plan_catalog_publish_operations` cascades off attempts (0038), so
  // clearing attempts is enough to reset both tables between tests.
  await db.query("DELETE FROM plan_catalog_publish_attempts");
});

const insertAttempt = async (
  overrides: Partial<{
    revisionId: string;
    mode: string;
    fingerprint: string;
    startedBy: string;
    startedAt: string;
  }> = {},
): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan_catalog_publish_attempts (revision_id, mode, fingerprint, started_by, started_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
     RETURNING id`,
    [
      overrides.revisionId ?? BASELINE_REVISION_ID,
      overrides.mode ?? "test",
      overrides.fingerprint ?? "fp-1",
      overrides.startedBy ?? "operator@tesserix",
      overrides.startedAt ?? null,
    ],
  );
  return rows[0].id;
};

let nextIdempotencyKey = 0;

const insertOperation = async (
  overrides: Partial<{
    attemptId: string;
    sequence: number;
    kind: string;
    stripeCall: string;
    status: string;
    finishedAt: string | null;
    error: string | null;
    idempotencyKey: string;
  }> = {},
): Promise<string> => {
  const attemptId = overrides.attemptId ?? (await insertAttempt());
  const status = overrides.status ?? "pending";
  const finishedAt =
    overrides.finishedAt !== undefined
      ? overrides.finishedAt
      : status === "pending"
        ? null
        : new Date().toISOString();
  const error = overrides.error !== undefined ? overrides.error : status === "failed" ? "boom" : null;
  const idempotencyKey = overrides.idempotencyKey ?? `key-${nextIdempotencyKey++}`;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan_catalog_publish_operations
       (attempt_id, sequence, kind, stripe_call, source, lookup_key, idempotency_key, status, error, finished_at)
     VALUES ($1, $2, $3, $4, 'mark8ly', 'mark8ly_pro_monthly_v1', $5, $6, $7, $8)
     RETURNING id`,
    [
      attemptId,
      overrides.sequence ?? 1,
      overrides.kind ?? "create_price",
      overrides.stripeCall ?? "create",
      idempotencyKey,
      status,
      error,
      finishedAt,
    ],
  );
  return rows[0].id;
};

/** Raw insert with full control over `stripe_call`, `status`, and
 *  `stripe_price_id` — `insertOperation` above always sets `stripe_call` to
 *  `create` by default and never sets `stripe_price_id` at all, neither of
 *  which fits `archivedStripePriceIds`'s test surface, which needs to
 *  distinguish archive rows from non-archive rows and vary status
 *  (`pending`/`failed`/`succeeded`) while a price id is always present. */
const insertArchiveRow = async (params: {
  attemptId: string;
  sequence: number;
  stripePriceId: string | null;
  status?: "pending" | "succeeded" | "failed";
  stripeCall?: "create" | "update" | "archive";
  source?: string;
  lookupKey?: string | null;
  idempotencyKey: string;
  // Only set by the "two lookup keys, one price id" test below, which needs
  // a deterministic `started_at` ORDER BY to prove WHICH row `DISTINCT ON`
  // picks — `now()`'s default has no such guarantee across two inserts a
  // fraction of a millisecond apart.
  startedAt?: string;
}): Promise<void> => {
  const status = params.status ?? "succeeded";
  const finishedAt = status === "pending" ? null : new Date().toISOString();
  const error = status === "failed" ? "boom" : null;
  await db.query(
    `INSERT INTO plan_catalog_publish_operations
       (attempt_id, sequence, kind, stripe_call, source, lookup_key, stripe_price_id, idempotency_key, status, error, finished_at, started_at)
     VALUES ($1, $2, 'archive_price', $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))`,
    [
      params.attemptId,
      params.sequence,
      params.stripeCall ?? "archive",
      params.source ?? "mark8ly",
      params.lookupKey ?? "mark8ly_pro_monthly_v1",
      params.stripePriceId,
      params.idempotencyKey,
      status,
      error,
      finishedAt,
      params.startedAt ?? null,
    ],
  );
};

describe("0038: plan_catalog_publish_attempts", () => {
  it("refuses an unknown outcome", async () => {
    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_attempts (revision_id, mode, fingerprint, started_by, outcome, finished_at)
         VALUES ($1, 'test', 'fp', 'op', 'cancelled', now())`,
        [BASELINE_REVISION_ID],
      ),
    ).rejects.toThrow(/violates/);
  });

  it("refuses an outcome with no finished_at, and a finished_at with no outcome", async () => {
    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_attempts (revision_id, mode, fingerprint, started_by, outcome)
         VALUES ($1, 'test', 'fp', 'op', 'succeeded')`,
        [BASELINE_REVISION_ID],
      ),
    ).rejects.toThrow(/coherent/);

    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_attempts (revision_id, mode, fingerprint, started_by, finished_at)
         VALUES ($1, 'test', 'fp', 'op', now())`,
        [BASELINE_REVISION_ID],
      ),
    ).rejects.toThrow(/coherent/);
  });
});

describe("0038: plan_catalog_publish_operations", () => {
  it("refuses an operation row with no attempt", async () => {
    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_operations
           (attempt_id, sequence, kind, stripe_call, source, idempotency_key, status)
         VALUES (gen_random_uuid(), 1, 'create_price', 'create', 'mark8ly', 'key-orphan', 'pending')`,
      ),
    ).rejects.toThrow(/violates/);
  });

  it("refuses a succeeded row with no finished_at", async () => {
    const attemptId = await insertAttempt();
    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_operations
           (attempt_id, sequence, kind, stripe_call, source, idempotency_key, status, finished_at)
         VALUES ($1, 1, 'create_price', 'create', 'mark8ly', 'key-succ-no-finish', 'succeeded', NULL)`,
        [attemptId],
      ),
    ).rejects.toThrow(/coherent/);
  });

  it("refuses a failed row with no error", async () => {
    const attemptId = await insertAttempt();
    await expect(
      db.query(
        `INSERT INTO plan_catalog_publish_operations
           (attempt_id, sequence, kind, stripe_call, source, idempotency_key, status, finished_at, error)
         VALUES ($1, 1, 'create_price', 'create', 'mark8ly', 'key-fail-no-error', 'failed', now(), NULL)`,
        [attemptId],
      ),
    ).rejects.toThrow(/coherent/);
  });

  it("allows two rows for one replace_price, because it is two Stripe calls", async () => {
    const attemptId = await insertAttempt();
    await insertOperation({ attemptId, sequence: 1, kind: "replace_price", stripeCall: "create" });
    await expect(
      insertOperation({ attemptId, sequence: 2, kind: "replace_price", stripeCall: "archive" }),
    ).resolves.toBeDefined();
  });

  it("refuses two operations with the same sequence in one attempt", async () => {
    const attemptId = await insertAttempt();
    await insertOperation({ attemptId, sequence: 1 });
    await expect(insertOperation({ attemptId, sequence: 1 })).rejects.toThrow(/unique/i);
  });

  it("refuses reusing an idempotency key, even across attempts", async () => {
    await insertOperation({ idempotencyKey: "shared-key" });
    await expect(insertOperation({ idempotencyKey: "shared-key" })).rejects.toThrow(/unique/i);
  });

  it("refuses an unknown kind", async () => {
    const attemptId = await insertAttempt();
    await expect(insertOperation({ attemptId, kind: "delete_everything" })).rejects.toThrow(
      /violates/,
    );
  });

  it("cascades: deleting the attempt deletes its operations", async () => {
    const attemptId = await insertAttempt();
    await insertOperation({ attemptId, sequence: 1 });

    await db.query("DELETE FROM plan_catalog_publish_attempts WHERE id = $1", [attemptId]);

    const { rows } = await db.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM plan_catalog_publish_operations WHERE attempt_id = $1",
      [attemptId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("publish-repo.ts: publish attempts", () => {
  it("starts an attempt and reads it back", async () => {
    const id = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-abc",
      startedBy: "operator@tesserix",
    });

    await expect(publishAttemptById(id)).resolves.toMatchObject({
      id,
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-abc",
      startedBy: "operator@tesserix",
      finishedAt: null,
      outcome: null,
    });
  });

  it("finishes an attempt with an outcome and a finish time", async () => {
    const id = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "live",
      fingerprint: "fp-xyz",
      startedBy: "operator@tesserix",
    });

    await finishPublishAttempt(id, "succeeded");

    const attempt = await publishAttemptById(id);
    expect(attempt?.outcome).toBe("succeeded");
    expect(attempt?.finishedAt).not.toBeNull();
  });

  it("refuses a second open attempt for the same mode, naming the existing one", async () => {
    // F3 (whole-branch fix wave, 2026-08-28): `startPublishAttempt` used to
    // take no lock and check nothing. `UNIQUE (idempotency_key)` protects
    // ONE attempt's own calls, but two open attempts each mint their own key
    // set (keys fold in `attemptId`) and both re-observe stale state, so both
    // can create — for a `replace_price` that means two new Prices, the
    // lookup key moving to whichever lands second, and the loser's Price left
    // ACTIVE with no lookup key, which the parity comparator structurally
    // cannot see (spec §9.2).
    const firstId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-open-1",
      startedBy: "operator-a@tesserix",
    });

    await expect(
      startPublishAttempt({
        revisionId: BASELINE_REVISION_ID,
        mode: "test",
        fingerprint: "fp-open-2",
        startedBy: "operator-b@tesserix",
      }),
    ).rejects.toThrow(new RegExp(firstId));
  });

  it("allows a new attempt for the same mode once the open one is finished", async () => {
    const firstId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-seq-1",
      startedBy: "operator@tesserix",
    });
    await finishPublishAttempt(firstId, "succeeded");

    await expect(
      startPublishAttempt({
        revisionId: BASELINE_REVISION_ID,
        mode: "test",
        fingerprint: "fp-seq-2",
        startedBy: "operator@tesserix",
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("scopes the open-attempt guard per mode, not globally", async () => {
    // An open `test` attempt must not block starting a `live` attempt — the
    // invariant is per-mode ("at most one open attempt per mode"), never
    // global (unlike `createDraftFrom`'s single shared lock — see this
    // function's own doc comment on why the two locks differ).
    await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-scope-1",
      startedBy: "operator@tesserix",
    });

    await expect(
      startPublishAttempt({
        revisionId: BASELINE_REVISION_ID,
        mode: "live",
        fingerprint: "fp-scope-2",
        startedBy: "operator@tesserix",
      }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe("publish-repo.ts: latestPublishAttempt", () => {
  it("returns null when the mode has recorded no attempts", async () => {
    await expect(latestPublishAttempt("live")).resolves.toBeNull();
  });

  it("returns the newest attempt for the mode", async () => {
    await insertAttempt({
      mode: "test",
      fingerprint: "fp-old",
      startedAt: "2026-08-28T09:00:00Z",
    });
    const newestId = await insertAttempt({
      mode: "test",
      fingerprint: "fp-new",
      startedAt: "2026-08-30T09:00:00Z",
    });
    await insertAttempt({
      mode: "test",
      fingerprint: "fp-middle",
      startedAt: "2026-08-29T09:00:00Z",
    });

    const attempt = await latestPublishAttempt("test");
    expect(attempt?.id).toBe(newestId);
    expect(attempt?.fingerprint).toBe("fp-new");
  });

  it("does not return an attempt recorded in the other mode", async () => {
    const testId = await insertAttempt({
      mode: "test",
      fingerprint: "fp-test",
      startedAt: "2026-08-28T09:00:00Z",
    });
    await insertAttempt({
      mode: "live",
      fingerprint: "fp-live",
      startedAt: "2026-08-30T09:00:00Z",
    });

    const attempt = await latestPublishAttempt("test");
    expect(attempt?.id).toBe(testId);
    expect(attempt?.mode).toBe("test");
  });

  it("returns an unfinished attempt, outcome still null", async () => {
    // The crash-between-start-and-finish case: this reader surfaces it rather
    // than filtering it out, because it is exactly the shape that strands an
    // orphaned Stripe Price. The caller decides what it means.
    const id = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-in-flight",
      startedBy: "operator@tesserix",
    });

    await expect(latestPublishAttempt("test")).resolves.toMatchObject({
      id,
      outcome: null,
      finishedAt: null,
    });
  });
});

describe("publish-repo.ts: operations", () => {
  it("records a pending operation before any Stripe outcome is known", async () => {
    const attemptId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-1",
      startedBy: "operator@tesserix",
    });

    const opId = await recordOperation({
      attemptId,
      sequence: 1,
      kind: "create_price",
      stripeCall: "create",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_v1",
      currency: "usd",
      idempotencyKey: "idem-1",
    });

    const [op] = await operationsForAttempt(attemptId);
    expect(op).toMatchObject({
      id: opId,
      sequence: 1,
      kind: "create_price",
      stripeCall: "create",
      status: "pending",
      stripePriceId: null,
      error: null,
    });
  });

  it("completes an operation as succeeded, recording the Stripe price id", async () => {
    const attemptId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-1",
      startedBy: "operator@tesserix",
    });
    const opId = await recordOperation({
      attemptId,
      sequence: 1,
      kind: "create_price",
      stripeCall: "create",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_v1",
      idempotencyKey: "idem-2",
    });

    await completeOperation(opId, { status: "succeeded", stripePriceId: "price_new_123" });

    const [op] = await operationsForAttempt(attemptId);
    expect(op.status).toBe("succeeded");
    expect(op.stripePriceId).toBe("price_new_123");
    expect(op.finishedAt).not.toBeNull();
  });

  it("completes an operation as failed, recording the error", async () => {
    const attemptId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-1",
      startedBy: "operator@tesserix",
    });
    const opId = await recordOperation({
      attemptId,
      sequence: 1,
      kind: "create_price",
      stripeCall: "create",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_v1",
      idempotencyKey: "idem-3",
    });

    await completeOperation(opId, { status: "failed", error: "Stripe: card declined" });

    const [op] = await operationsForAttempt(attemptId);
    expect(op.status).toBe("failed");
    expect(op.error).toBe("Stripe: card declined");
  });

  it("captures the old price id on the archive row of a replace_price, distinct from the create row", async () => {
    const attemptId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-1",
      startedBy: "operator@tesserix",
    });

    const createId = await recordOperation({
      attemptId,
      sequence: 1,
      kind: "replace_price",
      stripeCall: "create",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_v1",
      idempotencyKey: "idem-4-create",
    });
    await completeOperation(createId, { status: "succeeded", stripePriceId: "price_new_456" });

    const archiveId = await recordOperation({
      attemptId,
      sequence: 2,
      kind: "replace_price",
      stripeCall: "archive",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_v1",
      // Captured BEFORE the create per the migration's comment — this is the
      // OLD id, set at insert time, not learned from the create row.
      stripePriceId: "price_old_999",
      idempotencyKey: "idem-4-archive",
    });
    await completeOperation(archiveId, { status: "succeeded" });

    const [create, archive] = await operationsForAttempt(attemptId);
    expect(create.stripePriceId).toBe("price_new_456");
    expect(archive.stripePriceId).toBe("price_old_999");
    expect(archive.stripePriceId).not.toBe(create.stripePriceId);
  });

  it("orders operations by sequence, not insertion order", async () => {
    const attemptId = await startPublishAttempt({
      revisionId: BASELINE_REVISION_ID,
      mode: "test",
      fingerprint: "fp-1",
      startedBy: "operator@tesserix",
    });
    await recordOperation({
      attemptId,
      sequence: 2,
      kind: "create_price",
      stripeCall: "create",
      source: "mark8ly",
      idempotencyKey: "idem-seq-2",
    });
    await recordOperation({
      attemptId,
      sequence: 1,
      kind: "create_product",
      stripeCall: "create",
      source: "mark8ly",
      idempotencyKey: "idem-seq-1",
    });

    const ops = await operationsForAttempt(attemptId);
    expect(ops.map((o) => o.sequence)).toEqual([1, 2]);
  });
});

describe("publish-repo.ts: archivedStripePriceIds", () => {
  // Task 7 review, finding 1: this query must NOT filter on `status`. A
  // `pending` or `failed` archive row is exactly the crash-mid-`replace_price`
  // case orphan detection exists to catch (0038's header) — Stripe's own
  // `active: true` filter (`stripe-read.ts`) is the authoritative answer to
  // whether the Price is still live, so over-including candidates here costs
  // nothing (see `archivedStripePriceIds`'s doc comment in `publish-repo.ts`).
  it("returns archive rows regardless of status — pending and failed archives are exactly the case this exists to catch", async () => {
    const attemptId = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId,
      sequence: 1,
      stripePriceId: "price_pending",
      status: "pending",
      idempotencyKey: "archive-pending",
    });
    await insertArchiveRow({
      attemptId,
      sequence: 2,
      stripePriceId: "price_failed",
      status: "failed",
      idempotencyKey: "archive-failed",
    });
    await insertArchiveRow({
      attemptId,
      sequence: 3,
      stripePriceId: "price_succeeded",
      status: "succeeded",
      idempotencyKey: "archive-succeeded",
    });

    const archived = await archivedStripePriceIds("test", "mark8ly");

    expect(archived.map((a) => a.stripePriceId).sort()).toEqual(
      ["price_failed", "price_pending", "price_succeeded"].sort(),
    );
  });

  it("ignores stripe_call rows that are not archive — a create or update row is never a candidate", async () => {
    const attemptId = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId,
      sequence: 1,
      stripePriceId: "price_created",
      stripeCall: "create",
      idempotencyKey: "not-archive-create",
    });
    await insertArchiveRow({
      attemptId,
      sequence: 2,
      stripePriceId: "price_updated",
      stripeCall: "update",
      idempotencyKey: "not-archive-update",
    });
    await insertArchiveRow({
      attemptId,
      sequence: 3,
      stripePriceId: "price_archived",
      stripeCall: "archive",
      idempotencyKey: "not-archive-archive",
    });

    const archived = await archivedStripePriceIds("test", "mark8ly");

    expect(archived.map((a) => a.stripePriceId)).toEqual(["price_archived"]);
  });

  it("scopes by mode — an archive logged under live is invisible to a test-mode query", async () => {
    const liveAttempt = await insertAttempt({ mode: "live" });
    await insertArchiveRow({
      attemptId: liveAttempt,
      sequence: 1,
      stripePriceId: "price_live_only",
      idempotencyKey: "mode-scope-live",
    });

    await expect(archivedStripePriceIds("test", "mark8ly")).resolves.toEqual([]);
    await expect(archivedStripePriceIds("live", "mark8ly")).resolves.toMatchObject([
      { stripePriceId: "price_live_only" },
    ]);
  });

  it("scopes by source — a second product's archive never leaks into this catalog's orphan list", async () => {
    const attemptId = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId,
      sequence: 1,
      stripePriceId: "price_other_source",
      source: "a-second-product",
      idempotencyKey: "source-scope-other",
    });

    await expect(archivedStripePriceIds("test", "mark8ly")).resolves.toEqual([]);
    // `"a-second-product"` is not a real `CatalogSource` — the union has
    // exactly one member today (`source-policy.ts`) — but the SQL this
    // proves scopes on is a plain `text` column (0038) with no such
    // restriction, and won't gain one until a second product actually
    // exists. The cast is this test reaching past the app-level type to
    // exercise the query at the layer it actually runs, same as
    // `insertArchiveRow`'s own `source` staying `string` above.
    await expect(
      archivedStripePriceIds("test", "a-second-product" as CatalogSource),
    ).resolves.toMatchObject([{ stripePriceId: "price_other_source" }]);
  });

  it("DISTINCT collapses the same price id archived across two separate attempts", async () => {
    // Recovery from a crash is a NEW attempt, never a replay of an old one
    // (`startPublishAttempt`'s doc comment) — so the identical Stripe Price
    // id can legitimately be the target of an `archive` `stripe_call` in more
    // than one attempt's log. Without DISTINCT this would report the same
    // orphan twice.
    const firstAttempt = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId: firstAttempt,
      sequence: 1,
      stripePriceId: "price_retried",
      status: "failed",
      idempotencyKey: "retry-attempt-1",
    });
    const secondAttempt = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId: secondAttempt,
      sequence: 1,
      stripePriceId: "price_retried",
      status: "succeeded",
      idempotencyKey: "retry-attempt-2",
    });

    const archived = await archivedStripePriceIds("test", "mark8ly");

    expect(archived.map((a) => a.stripePriceId)).toEqual(["price_retried"]);
  });

  it("carries the lookup key and source through for the row it found", async () => {
    const attemptId = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId,
      sequence: 1,
      stripePriceId: "price_with_key",
      lookupKey: "mark8ly_pro_annual_developed_v1",
      idempotencyKey: "carries-fields",
    });

    const archived = await archivedStripePriceIds("test", "mark8ly");

    expect(archived).toMatchObject([
      {
        stripePriceId: "price_with_key",
        lookupKey: "mark8ly_pro_annual_developed_v1",
        source: "mark8ly",
      },
    ]);
  });

  // #411's minor 1: the ORIGINAL `DISTINCT` on the whole
  // `(stripe_price_id, lookup_key, source)` tuple only collapses retries
  // that logged the IDENTICAL tuple. It does not when the same old Price
  // was archived under two DIFFERENT recorded lookup keys across attempts
  // (a plan re-planned between a failed attempt and its retry — e.g. a
  // lookup key renamed mid-draft) — the tuple differs, both rows survive a
  // plain `DISTINCT`, and `findOrphans` would report the one Price TWICE.
  // This case had no coverage before this test; see `archivedStripePriceIds`'s
  // doc comment for why `DISTINCT ON (stripe_price_id)` is the fix and why
  // the MOST RECENT attempt's key is the one shown.
  it("collapses one price id recorded under two different lookup keys across retries, to the most recent key", async () => {
    const firstAttempt = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId: firstAttempt,
      sequence: 1,
      stripePriceId: "price_relabeled",
      status: "failed",
      lookupKey: "mark8ly_pro_monthly_developed_v1",
      idempotencyKey: "relabel-attempt-1",
      startedAt: "2026-08-01T00:00:00Z",
    });
    const secondAttempt = await insertAttempt({ mode: "test" });
    await insertArchiveRow({
      attemptId: secondAttempt,
      sequence: 1,
      stripePriceId: "price_relabeled",
      status: "succeeded",
      lookupKey: "mark8ly_pro_monthly_developed_v2",
      idempotencyKey: "relabel-attempt-2",
      startedAt: "2026-08-02T00:00:00Z",
    });

    const archived = await archivedStripePriceIds("test", "mark8ly");

    // ONE row, not two — a duplicated row is the actual defect this test
    // guards against — carrying the SECOND (later) attempt's lookup key,
    // not the first.
    expect(archived).toMatchObject([
      {
        stripePriceId: "price_relabeled",
        lookupKey: "mark8ly_pro_monthly_developed_v2",
        source: "mark8ly",
      },
    ]);
  });
});

