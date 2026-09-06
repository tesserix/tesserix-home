import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The TOTP cooldown's store, against real (in-process) Postgres via pglite
 * (#457).
 *
 * Real SQL rather than an asserted query string, because what is being claimed
 * is arithmetic Postgres does: that the count is taken over a moving window,
 * that the cooldown therefore ends without anything unlocking it, and that two
 * login names never share a counter. None of those are visible in the text of
 * a query.
 *
 * Own pglite instance — see crm-writes.integration.test.ts for why a `vi.mock`
 * in one test file cannot be shared with another.
 */

const dbHolder = vi.hoisted(() => ({
  db: undefined as unknown,
  /** Set to make every query throw, standing in for a database that is wired
   *  up and answering with errors — a failover, an exhausted pool, a dropped
   *  connection. Distinct from `configured` below, which is the deployment
   *  that has no database credentials at all. */
  broken: false,
  configured: true,
}));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      if (dbHolder.broken) throw new Error("connection refused");
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    isDatabaseConfigured: () => dbHolder.configured,
  };
});

const { LOGIN_THROTTLE_HASH_KEY_ENV, loginNameHash } = await import("./login-throttle-hash");
const {
  TOTP_FAILURE_THRESHOLD,
  TOTP_FAILURE_WINDOW_MS,
  clearTotpFailures,
  recordLoginIdentity,
  recordTotpFailure,
  totpCooldownFor,
} = await import("./login-throttle");

const VICTIM = "victim@tesserix.test";
const ATTACKER = "attacker@tesserix.test";

/** A half-finished login, as the login actions hold one: the auth request the
 *  browser carries and the Zitadel session the password step created. */
function pending(authRequestId: string, sessionId = `sess-${authRequestId}`) {
  return { authRequestId, sessionId };
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  const migration = path.resolve(
    __dirname,
    "../../../web/db/migrations/0050_login_totp_cooldown.sql",
  );
  await db.exec(readFileSync(migration, "utf-8"));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  dbHolder.broken = false;
  dbHolder.configured = true;
  vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "test-key");
  await db.exec("DELETE FROM login_pending_identity; DELETE FROM login_totp_failures;");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Fail `count` times against the login parked on `request`. */
async function failTimes(request: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await recordTotpFailure(pending(request));
}

/** Backdate every recorded failure, standing in for the window elapsing.
 *  Time is moved in the DATABASE because `now()` is evaluated there — a fake
 *  timer in this process would not reach it. */
async function ageFailuresBy(ms: number): Promise<void> {
  await db.query("UPDATE login_totp_failures SET failed_at = failed_at - $1::interval", [
    `${ms} milliseconds`,
  ]);
}

async function failureCount(loginName: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM login_totp_failures WHERE login_name_hash = $1",
    [loginNameHash(loginName)],
  );
  return rows.rows[0].n;
}

describe("the cooldown", () => {
  it("forwards attempts below the threshold", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD - 1);

    // One short is still a login in progress, not an attack. A limiter that
    // bites on a genuine second mis-type would be a support ticket per week.
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });

  it("declines the next attempt once the threshold is reached", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    const cooldown = await totpCooldownFor(pending("req-1"));
    expect(cooldown).not.toBeNull();
    // Measured from the OLDEST of the counted failures, because that is the
    // one whose ageing out drops the count back below the threshold.
    expect(cooldown!.retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(cooldown!.retryAt.getTime()).toBeLessThanOrEqual(Date.now() + TOTP_FAILURE_WINDOW_MS);
  });

  it("does not record a failure for an attempt it declined", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    // The caller must not call `recordTotpFailure` for a declined attempt —
    // but the store must not depend on the caller's discipline for the
    // property that matters: hammering a closed door cannot extend the
    // cooldown, because the count is over a window and the window moves.
    await ageFailuresBy(TOTP_FAILURE_WINDOW_MS + 1000);
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });

  it("expires on its own, with nothing unlocked", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);
    expect(await totpCooldownFor(pending("req-1"))).not.toBeNull();

    // Still inside the window: the cooldown holds.
    await ageFailuresBy(TOTP_FAILURE_WINDOW_MS - 60_000);
    expect(await totpCooldownFor(pending("req-1"))).not.toBeNull();

    // Past it: no operation ran, no state was reset, and the operator is
    // through. This is the whole difference between this and a lockout.
    await ageFailuresBy(120_000);
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });

  it("clears the count on a successful code", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD - 1);

    await clearTotpFailures(pending("req-1"));
    expect(await failureCount(VICTIM)).toBe(0);

    // Mirrors Zitadel's own reset-on-success: an operator who fumbles twice
    // and then gets it right starts their next login clean, rather than
    // carrying yesterday's near-misses into it.
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD - 1);
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });

  it("keeps one operator's failures off another's counter", async () => {
    await recordLoginIdentity(pending("req-victim"), VICTIM);
    await recordLoginIdentity(pending("req-attacker"), ATTACKER);

    await failTimes("req-attacker", TOTP_FAILURE_THRESHOLD);

    expect(await failureCount(ATTACKER)).toBe(TOTP_FAILURE_THRESHOLD);
    expect(await failureCount(VICTIM)).toBe(0);
    await expect(totpCooldownFor(pending("req-victim"))).resolves.toBeNull();
  });

  it("survives the auth request that produced it", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    // An attacker refused on one auth request simply starts another. The
    // count is keyed on the login name, not on the request, so the new
    // request inherits the cooldown — without this the limiter would reset
    // on every retry and bound nothing at all.
    await recordLoginIdentity(pending("req-2"), VICTIM);
    await expect(totpCooldownFor(pending("req-2"))).resolves.not.toBeNull();
  });
});

describe("an auth request with no server-side identity", () => {
  it("is not counted against anyone", async () => {
    // No `recordLoginIdentity` ran for this request, so there is no login
    // name the server can vouch for. Guessing one is the hole this design
    // exists to close, so the limiter simply does not apply.
    await recordTotpFailure(pending("req-unknown"));
    await expect(totpCooldownFor(pending("req-unknown"))).resolves.toBeNull();

    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM login_totp_failures");
    expect(rows.rows[0].n).toBe(0);
  });

  it("is what somebody else's auth request id becomes", async () => {
    // The auth request id IS carried by the client, so on its own it would be
    // a name an attacker could assert. Presenting the victim's id against a
    // session that is not the victim's resolves to nothing, and the victim's
    // counter is untouched.
    await recordLoginIdentity(pending("req-victim"), VICTIM);

    await recordTotpFailure({ authRequestId: "req-victim", sessionId: "sess-attacker" });

    expect(await failureCount(VICTIM)).toBe(0);
    await expect(
      totpCooldownFor({ authRequestId: "req-victim", sessionId: "sess-attacker" }),
    ).resolves.toBeNull();
  });

  it("is what a mapping older than the login it described becomes", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await db.query("UPDATE login_pending_identity SET created_at = created_at - interval '1 day'");

    await recordTotpFailure(pending("req-1"));
    expect(await failureCount(VICTIM)).toBe(0);
  });
});

describe("when the hash key is unset", () => {
  it("forwards every attempt rather than refusing every login", async () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "");

    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD * 2);

    // Fail open. A console whose operators cannot sign in because a secret
    // has not been provisioned is a worse outage than the one this control
    // mitigates — and Zitadel's own `maxOtpAttempts` is still in force
    // underneath, so this degrades to the state that shipped before #457
    // rather than below it.
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });
});

describe("when the database is unreachable", () => {
  it("forwards the attempt instead of taking the console down with it", async () => {
    await recordLoginIdentity(pending("req-1"), VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);
    expect(await totpCooldownFor(pending("req-1"))).not.toBeNull();

    dbHolder.broken = true;

    // The same call, the same reasoning as the unset key: refusing every TOTP
    // attempt because a limiter table is unreachable would lock every
    // operator out of the console — which is precisely the denial of service
    // this feature exists to prevent, only self-inflicted.
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });

  it("does not turn a failed write into a failed login", async () => {
    dbHolder.broken = true;

    await expect(recordLoginIdentity(pending("req-1"), VICTIM)).resolves.toBeUndefined();
    await expect(recordTotpFailure(pending("req-1"))).resolves.toBeUndefined();
    await expect(clearTotpFailures(pending("req-1"))).resolves.toBeUndefined();
  });
});

describe("on a deployment with no database credentials at all", () => {
  it("does not attempt a query", async () => {
    // The console can be deployed without `TESSERIX_DB_*` — `isDatabaseConfigured`
    // exists precisely for that window. Asking anyway would throw out of
    // `getPool()` on every single login attempt.
    dbHolder.configured = false;
    dbHolder.broken = true;

    await expect(recordLoginIdentity(pending("req-1"), VICTIM)).resolves.toBeUndefined();
    await expect(totpCooldownFor(pending("req-1"))).resolves.toBeNull();
  });
});
