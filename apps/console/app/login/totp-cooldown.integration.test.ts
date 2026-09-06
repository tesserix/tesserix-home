import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginClientError } from "@/lib/auth/zitadel-login-client";

/**
 * The TOTP cooldown, through the actions that use it (#457).
 *
 * `actions.test.ts` covers the second factor's own logic and mocks nothing
 * below it; this file is the one that needs a database, because the claims are
 * about what is counted, against whom, and whether Zitadel is reached at all.
 *
 * Real (in-process) Postgres via pglite rather than a mocked repo, for the
 * reason the store's own test gives: the limiter is arithmetic Postgres does.
 * A mocked `totpCooldownFor` would let this file agree with itself about a
 * cooldown that the real query never produces.
 */

const client = vi.hoisted(() => ({
  getAuthRequest: vi.fn(),
  createPasswordSession: vi.fn(),
  getLoginPolicy: vi.fn(),
  getEnrolledFactors: vi.fn(),
  addTotpCheck: vi.fn(),
  finalize: vi.fn(),
  loginClientConfig: vi.fn(),
}));

vi.mock("@/lib/auth/zitadel-login-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/zitadel-login-client")>();
  return { ...actual, ...client };
});

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown, broken: false }));

vi.mock("@/lib/db/tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/tesserix")>();
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
    isDatabaseConfigured: () => true,
  };
});

/** The cookie jar, and the reason this file can forge one: `tx_login_pending`
 *  is httpOnly but plain unsigned JSON, so anything a browser can be made to
 *  send, a test can write directly. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { LOGIN_THROTTLE_HASH_KEY_ENV, loginNameHash } = await import("@/lib/db/login-throttle-hash");
const { TOTP_FAILURE_THRESHOLD } = await import("@/lib/db/login-throttle");
const { submitCredentials, submitTotp } = await import("./actions");

const TOTP = "AUTHENTICATION_METHOD_TYPE_TOTP";
const VICTIM = "victim@tesserix.test";
const ATTACKER = "attacker@tesserix.test";

/** A session per login name, so an assertion about whose failures were counted
 *  cannot pass by two logins sharing one session id. */
const SESSIONS: Record<string, { id: string; token: string }> = {
  [VICTIM]: { id: "sess-victim", token: "tok-victim" },
  [ATTACKER]: { id: "sess-attacker", token: "tok-attacker" },
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  await db.exec(
    readFileSync(
      path.resolve(__dirname, "../../../web/db/migrations/0050_login_totp_cooldown.sql"),
      "utf-8",
    ),
  );
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  jar.clear();
  dbHolder.broken = false;
  vi.clearAllMocks();
  vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "test-key");
  await db.exec("DELETE FROM login_pending_identity; DELETE FROM login_totp_failures;");

  client.loginClientConfig.mockReturnValue({ issuer: "https://auth.test", token: "pat" });
  client.getAuthRequest.mockResolvedValue({ id: "req-1", clientId: "console-web" });
  client.createPasswordSession.mockImplementation(async (_config, loginName: string) =>
    SESSIONS[loginName.trim().toLowerCase()],
  );
  client.getLoginPolicy.mockResolvedValue({ forceMfa: true, forceMfaLocalOnly: false });
  client.getEnrolledFactors.mockResolvedValue({ secondFactorTypes: [TOTP], passkeyCount: 0 });
  client.addTotpCheck.mockResolvedValue({});
  client.finalize.mockResolvedValue("https://console.tesserix.app/auth/callback?code=abc");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const REJECTED = new LoginClientError("bad-credentials", "Errors.User.MFA.OTP.InvalidCode");

/** Get past the password step for `loginName` on `authRequestId`, which is
 *  what writes the server-side mapping the limiter keys on. */
async function pastThePassword(authRequestId: string, loginName: string): Promise<void> {
  await submitCredentials({ authRequestId, loginName, password: "pw" });
}

async function failTimes(authRequestId: string, count: number): Promise<void> {
  client.addTotpCheck.mockRejectedValue(REJECTED);
  for (let i = 0; i < count; i += 1) {
    await submitTotp({ authRequestId, code: "000000" });
  }
  client.addTotpCheck.mockResolvedValue({});
}

async function failureCount(loginName: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM login_totp_failures WHERE login_name_hash = $1",
    [loginNameHash(loginName)],
  );
  return rows.rows[0].n;
}

describe("a login that has spent its attempts", () => {
  it("stops calling Zitadel at all", async () => {
    await pastThePassword("req-1", VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    client.addTotpCheck.mockClear();
    const result = await submitTotp({ authRequestId: "req-1", code: "111111" });

    // THE WHOLE MECHANISM. Zitadel's `maxOtpAttempts` counter cannot be
    // advanced by a request that is never made, which is why this assertion —
    // and not the message below it — is what makes the lockout unreachable.
    expect(client.addTotpCheck).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failed");
  });

  it("tells the operator they are not locked, and when to come back", async () => {
    await pastThePassword("req-1", VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    const result = await submitTotp({ authRequestId: "req-1", code: "111111" });
    const message = "message" in result ? result.message : "";

    // The console is where an operator goes to find out whether they are
    // locked out. Saying "locked" here would send them to a break-glass
    // procedure for a state that clears itself in a quarter of an hour.
    expect(message.toLowerCase()).not.toContain("lock");
    // And it has to say when, or the only remaining move is to keep trying.
    expect(message).toMatch(/\d+ minute/);
  });

  it("does not count the attempt it refused to send", async () => {
    await pastThePassword("req-1", VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    await submitTotp({ authRequestId: "req-1", code: "111111" });

    // Otherwise hammering a closed door would extend the cooldown forever,
    // which is the lockout again under a different name.
    expect(await failureCount(VICTIM)).toBe(TOTP_FAILURE_THRESHOLD);
  });

  it("still lets a correct code through before the threshold, and forgets the misses", async () => {
    await pastThePassword("req-1", VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD - 1);

    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toMatchObject({
      outcome: "complete",
    });
    expect(await failureCount(VICTIM)).toBe(0);
  });
});

describe("a forged tx_login_pending cookie", () => {
  it("cannot move one operator's failures onto another's counter", async () => {
    // Both operators have a login in flight, so the victim's mapping really
    // is in the table and really could be found — this is not passing because
    // there was nothing to hit.
    await pastThePassword("req-victim", VICTIM);
    await pastThePassword("req-attacker", ATTACKER);

    // The attacker rewrites the cookie by hand: the victim's auth request id,
    // and — since httpOnly stops the page's JavaScript and not curl — a
    // `loginName` field naming the victim outright, which is the shape this
    // design refuses to read. Their own session id and token stay, because
    // without them Zitadel would reject the request before it counted for
    // anything.
    jar.set(
      "tx_login_pending",
      JSON.stringify({
        authRequestId: "req-victim",
        sessionId: SESSIONS[ATTACKER].id,
        sessionToken: SESSIONS[ATTACKER].token,
        loginName: VICTIM,
      }),
    );

    await failTimes("req-victim", TOTP_FAILURE_THRESHOLD * 2);

    // Not one failure landed on the victim. The login name is resolved from
    // the row the SERVER wrote at the password step, keyed on the auth request
    // AND the session; the cookie contributes a lookup key, never a name.
    expect(await failureCount(VICTIM)).toBe(0);
    // And the victim's own next code is still forwarded, which is the harm
    // that would have been done.
    jar.clear();
    await pastThePassword("req-victim", VICTIM);
    client.addTotpCheck.mockClear();
    await submitTotp({ authRequestId: "req-victim", code: "123456" });
    expect(client.addTotpCheck).toHaveBeenCalled();
  });
});

describe("when the database is unreachable", () => {
  it("forwards the code rather than refusing every login", async () => {
    await pastThePassword("req-1", VICTIM);
    await failTimes("req-1", TOTP_FAILURE_THRESHOLD);

    dbHolder.broken = true;
    client.addTotpCheck.mockClear();

    // Fail open. A limiter that cannot be read must not become a console
    // nobody can sign in to — that is the same outage this control exists to
    // prevent, only self-inflicted and affecting every operator at once.
    await expect(submitTotp({ authRequestId: "req-1", code: "123456" })).resolves.toMatchObject({
      outcome: "complete",
    });
    expect(client.addTotpCheck).toHaveBeenCalled();
  });
});
