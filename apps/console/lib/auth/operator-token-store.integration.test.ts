import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the operator token store against a real (in-process)
 * Postgres, loading the REAL migration — `0029_operator_api_tokens.sql` — rather
 * than a hand-written approximation of it. The column names, the `bytea`
 * columns, the `timestamptz` round-trip and the primary key on `sid` are a
 * contract with that file; a test against a fixture schema proves only that the
 * fixture agrees with itself.
 *
 * Same shape as `lib/db/crm-writes.integration.test.ts`: pglite is a single
 * embedded session, so it IS the query runner, structurally.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("../db/tesserix", () => ({
  isDatabaseConfigured: () => true,
  tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
    const db = dbHolder.db as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    };
    const result = await db.query(sql, params as unknown[]);
    return result.rows;
  },
}));

const { saveTokens, readTokens, deleteTokens, pruneExpired } = await import(
  "./operator-token-store"
);

let db: PGlite;

const HOUR = 60 * 60 * 1000;
const future = (ms: number) => new Date(Date.now() + ms);
const past = (ms: number) => new Date(Date.now() - ms);

beforeAll(async () => {
  process.env.OPERATOR_TOKEN_ENCRYPT_KEY = "0123456789abcdef0123456789abcdef";
  db = new PGlite();
  dbHolder.db = db;
  const migrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0029_operator_api_tokens.sql",
  );
  await db.exec(readFileSync(migrationPath, "utf-8"));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM operator_api_tokens");
});

describe("save → read → delete", () => {
  it("round-trips both tokens and the access expiry", async () => {
    const accessExpiresAt = future(HOUR);
    await saveTokens(
      "sid-round-trip",
      "sub-1",
      {
        accessToken: "ya29.access-token-value",
        accessExpiresAt,
        refreshToken: "refresh-token-value",
      },
      future(7 * 24 * HOUR),
    );

    const stored = await readTokens("sid-round-trip");
    expect(stored).not.toBeNull();
    expect(stored!.accessToken).toBe("ya29.access-token-value");
    expect(stored!.refreshToken).toBe("refresh-token-value");
    // timestamptz survives the round trip to the millisecond.
    expect(stored!.accessExpiresAt.getTime()).toBe(accessExpiresAt.getTime());
  });

  it("writes ciphertext, not plaintext, into the bytea columns", async () => {
    await saveTokens(
      "sid-cipher",
      "sub-1",
      {
        accessToken: "plaintext-access",
        accessExpiresAt: future(HOUR),
        refreshToken: "plaintext-refresh",
      },
      future(HOUR),
    );
    const { rows } = await db.query<{
      access_token: Uint8Array;
      refresh_token: Uint8Array;
    }>("SELECT access_token, refresh_token FROM operator_api_tokens WHERE sid = $1", [
      "sid-cipher",
    ]);
    const asText = (v: Uint8Array) => Buffer.from(v).toString("utf8");
    expect(asText(rows[0].access_token)).not.toContain("plaintext-access");
    expect(asText(rows[0].refresh_token)).not.toContain("plaintext-refresh");
    // And the envelope is iv || tag || ciphertext: 12 + 16 + len(plaintext).
    expect(rows[0].access_token.length).toBe(12 + 16 + "plaintext-access".length);
  });

  it("stores a null refresh token, and reads it back as null", async () => {
    await saveTokens(
      "sid-no-refresh",
      "sub-1",
      { accessToken: "a", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    const stored = await readTokens("sid-no-refresh");
    expect(stored!.accessToken).toBe("a");
    expect(stored!.refreshToken).toBeNull();
  });

  it("upserts on sid: a refresh replaces the row rather than colliding", async () => {
    await saveTokens(
      "sid-upsert",
      "sub-1",
      { accessToken: "first", accessExpiresAt: future(HOUR), refreshToken: "r1" },
      future(HOUR),
    );
    await saveTokens(
      "sid-upsert",
      "sub-1",
      { accessToken: "second", accessExpiresAt: future(2 * HOUR), refreshToken: "r2" },
      future(2 * HOUR),
    );
    const stored = await readTokens("sid-upsert");
    expect(stored!.accessToken).toBe("second");
    expect(stored!.refreshToken).toBe("r2");
    const { rows } = await db.query("SELECT sid FROM operator_api_tokens");
    expect(rows).toHaveLength(1);
  });

  it("keeps one operator's two sessions apart", async () => {
    await saveTokens(
      "sid-browser-a",
      "sub-same",
      { accessToken: "token-a", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    await saveTokens(
      "sid-browser-b",
      "sub-same",
      { accessToken: "token-b", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    expect((await readTokens("sid-browser-a"))!.accessToken).toBe("token-a");
    expect((await readTokens("sid-browser-b"))!.accessToken).toBe("token-b");
  });

  it("deleteTokens removes only that session's row", async () => {
    for (const sid of ["sid-gone", "sid-stays"]) {
      await saveTokens(
        sid,
        "sub-1",
        { accessToken: sid, accessExpiresAt: future(HOUR), refreshToken: null },
        future(HOUR),
      );
    }
    await deleteTokens("sid-gone");
    expect(await readTokens("sid-gone")).toBeNull();
    expect((await readTokens("sid-stays"))!.accessToken).toBe("sid-stays");
  });

  it("deleting an unknown sid is a silent no-op", async () => {
    await expect(deleteTokens("sid-never-existed")).resolves.toBeUndefined();
  });
});

describe("readTokens for an unknown sid", () => {
  it("returns null", async () => {
    expect(await readTokens("sid-that-was-never-written")).toBeNull();
  });
});

describe("readTokens against a tampered row", () => {
  it("returns null rather than a partially decrypted token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await saveTokens(
      "sid-tampered",
      "sub-1",
      { accessToken: "a-real-token", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    // Flip one bit of the ciphertext body, in the database, exactly as a
    // corrupt page or a meddling operator would.
    await db.query(
      `UPDATE operator_api_tokens
          SET access_token = set_byte(access_token, 30, get_byte(access_token, 30) # 1)
        WHERE sid = $1`,
      ["sid-tampered"],
    );
    expect(await readTokens("sid-tampered")).toBeNull();
    error.mockRestore();
  });
});

describe("pruneExpired", () => {
  it("removes only rows past session_expires_at", async () => {
    await saveTokens(
      "sid-live",
      "sub-1",
      { accessToken: "live", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    // Written directly: saveTokens prunes after every write, so an
    // already-expired row inserted through it would sweep itself before the
    // assertion could see it.
    await db.query(
      `INSERT INTO operator_api_tokens
         (sid, sub, access_token, access_expires_at, session_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      ["sid-expired", "sub-1", new Uint8Array([1, 2, 3]), past(HOUR), past(HOUR)],
    );
    // An access token that expired but whose SESSION has not: this row must
    // survive, because it is exactly the row the refresh path exists to renew.
    await db.query(
      `INSERT INTO operator_api_tokens
         (sid, sub, access_token, access_expires_at, session_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      ["sid-stale-access", "sub-1", new Uint8Array([1, 2, 3]), past(HOUR), future(HOUR)],
    );

    await pruneExpired();

    const { rows } = await db.query<{ sid: string }>(
      "SELECT sid FROM operator_api_tokens ORDER BY sid",
    );
    expect(rows.map((r) => r.sid)).toEqual(["sid-live", "sid-stale-access"]);
  });

  it("runs opportunistically on every write", async () => {
    await db.query(
      `INSERT INTO operator_api_tokens
         (sid, sub, access_token, access_expires_at, session_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      ["sid-expired", "sub-1", new Uint8Array([1, 2, 3]), past(HOUR), past(HOUR)],
    );
    await saveTokens(
      "sid-new",
      "sub-2",
      { accessToken: "n", accessExpiresAt: future(HOUR), refreshToken: null },
      future(HOUR),
    );
    const { rows } = await db.query<{ sid: string }>(
      "SELECT sid FROM operator_api_tokens",
    );
    expect(rows.map((r) => r.sid)).toEqual(["sid-new"]);
  });
});

describe("inside a transaction", () => {
  it("SELECT ... FOR UPDATE reads the row the refresh path will replace", async () => {
    await saveTokens(
      "sid-locked",
      "sub-1",
      { accessToken: "before", accessExpiresAt: future(HOUR), refreshToken: "r-before" },
      future(HOUR),
    );

    // The shape the later refresh task needs: one client, BEGIN, locked read,
    // write, COMMIT. pglite is that client.
    const query = (async (sql: string, params: readonly unknown[] = []) => {
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    }) as never;

    await db.exec("BEGIN");
    const locked = await readTokens("sid-locked", { query, forUpdate: true });
    expect(locked!.accessToken).toBe("before");
    await saveTokens(
      "sid-locked",
      "sub-1",
      { accessToken: "after", accessExpiresAt: future(2 * HOUR), refreshToken: "r-after" },
      future(2 * HOUR),
      { query },
    );
    await db.exec("COMMIT");

    const stored = await readTokens("sid-locked");
    expect(stored!.accessToken).toBe("after");
    expect(stored!.refreshToken).toBe("r-after");
  });
});
