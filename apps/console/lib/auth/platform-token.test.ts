import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxQuery } from "../db/tesserix";
import type {
  OperatorTokensInput,
  ReadTokensOptions,
  StoredOperatorTokens,
  TokenStoreOptions,
} from "./operator-token-store";

/**
 * This file is about the DECISION — serve the stored token, renew it under a
 * lock, or admit there is none. The session, the OIDC client, the store and the
 * transaction are all doubled: JWE, HTTP, AES-GCM and the SQL each have their
 * own tests, and none of them is what can go wrong here.
 *
 * The store double is a real in-memory row keyed by `sid`, and the `tesserixTx`
 * double is a real mutex. That combination is what makes the concurrency test
 * meaningful: the fake serialises transactions the way Postgres serialises
 * `SELECT ... FOR UPDATE`, so a second caller genuinely observes the first
 * one's committed write — and only the re-check inside the lock stops it
 * spending the refresh token a second time.
 */

interface Row {
  sub: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string | null;
  sessionExpiresAt: Date;
}

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  row: null as unknown,
  /** Set to make the store behave as if there is no database and no key. */
  storeUnusable: false,
  /** Set to make the write inside the transaction fail. */
  saveThrows: false,
  /** Set to make the transaction itself unopenable (no database at all). */
  txThrows: false,
  refreshCalls: 0,
  refreshDelayMs: 0,
  /** Successive refresh responses; the last one repeats. */
  refreshResponses: [] as (Record<string, unknown> | null)[],
  configThrows: false,
  /** Rewrites the row to a freshly-refreshed one just before the LOCKED read
   *  answers, standing in for another request having committed while this one
   *  waited on the lock. */
  refreshedWhileWaiting: false,
  /** Every options object the store was called with, for contract assertions. */
  readOptions: [] as ReadTokensOptions[],
  saveOptions: [] as TokenStoreOptions[],
  saved: [] as OperatorTokensInput[],
  /** Resolves once a caller is inside the transaction, blocking on the IdP. */
  txDepth: 0,
  maxTxDepth: 0,
}));

vi.mock("@tesserix/platform-auth", () => ({
  getCurrentSession: async () => state.session,
}));

vi.mock("./oidc", () => ({
  getOidcConfig: () => {
    if (state.configThrows) throw new Error("not configured");
    return { issuer: "https://auth.test", clientId: "c", clientSecret: "s" };
  },
  refreshAccessToken: async () => {
    state.refreshCalls += 1;
    if (state.refreshDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.refreshDelayMs));
    }
    return (
      state.refreshResponses.shift() ??
      state.refreshResponses[state.refreshResponses.length - 1] ??
      null
    );
  },
}));

vi.mock("./operator-token-store", () => ({
  readTokens: async (
    sid: string,
    options: ReadTokensOptions = {},
  ): Promise<StoredOperatorTokens | null> => {
    state.readOptions.push(options);
    // "No key, or no database" — the store degrades to null, it does not throw.
    if (state.storeUnusable) return null;
    if (state.refreshedWhileWaiting && options.forUpdate) {
      seedRow({
        accessToken: "someone-elses-renewal",
        accessExpiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: "rotated-1",
      });
    }
    const row = state.row as Record<string, Row> | null;
    const found = row?.[sid];
    if (!found) return null;
    return {
      accessToken: found.accessToken,
      accessExpiresAt: found.accessExpiresAt,
      refreshToken: found.refreshToken,
    };
  },
  saveTokens: async (
    sid: string,
    sub: string,
    tokens: OperatorTokensInput,
    sessionExpiresAt: Date,
    options: TokenStoreOptions = {},
  ): Promise<void> => {
    state.saveOptions.push(options);
    state.saved.push(tokens);
    // The transaction path rethrows, by the store's own contract.
    if (state.saveThrows) throw new Error("write failed");
    if (state.storeUnusable) return;
    const rows = (state.row ?? {}) as Record<string, Row>;
    rows[sid] = {
      sub,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshToken: tokens.refreshToken ?? null,
      sessionExpiresAt,
    };
    state.row = rows;
  },
}));

// A mutex, because that is what `SELECT ... FOR UPDATE` is to this module.
// Serialising at BEGIN rather than at the SELECT makes the double STRICTER
// than Postgres, not weaker: a waiter is guaranteed to see the previous
// transaction's committed row, so a missing re-check is guaranteed to show up
// as a second refresh.
let txChain: Promise<unknown> = Promise.resolve();

vi.mock("../db/tesserix", () => ({
  tesserixTx: async <T,>(fn: (query: TxQuery) => Promise<T>): Promise<T> => {
    const run = txChain.then(async () => {
      if (state.txThrows) throw new Error("tesserix DB env not set");
      state.txDepth += 1;
      state.maxTxDepth = Math.max(state.maxTxDepth, state.txDepth);
      try {
        return await fn(txQuery);
      } finally {
        state.txDepth -= 1;
      }
    });
    // The chain must not break on a rejected transaction, or every later
    // caller would inherit the failure.
    txChain = run.catch(() => undefined);
    return (await run) as T;
  },
}));

/** Stands in for the transaction's scoped query. Nothing calls it — the store
 *  is doubled — but its identity is what the contract assertions check. */
const txQuery: TxQuery = async () => [];

const now = () => Math.floor(Date.now() / 1000);

function seedRow(over: Partial<Row> & { accessExpiresAt: Date }): void {
  state.row = {
    "sid-1": {
      sub: "operator-1",
      accessToken: "stored",
      refreshToken: "refresh-1",
      sessionExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      ...over,
    },
  };
}

beforeEach(() => {
  state.session = { sub: "operator-1", sid: "sid-1", exp: now() + 7 * 86_400 };
  state.row = null;
  state.storeUnusable = false;
  state.saveThrows = false;
  state.txThrows = false;
  state.refreshCalls = 0;
  state.refreshDelayMs = 0;
  state.refreshResponses = [];
  state.configThrows = false;
  state.refreshedWhileWaiting = false;
  state.readOptions = [];
  state.saveOptions = [];
  state.saved = [];
  state.txDepth = 0;
  state.maxTxDepth = 0;
  txChain = Promise.resolve();
  vi.resetModules();
});

async function getToken() {
  const { getPlatformApiToken } = await import("./platform-token");
  return getPlatformApiToken();
}

describe("getPlatformApiToken", () => {
  it("returns null when there is no session", async () => {
    state.session = null;
    expect(await getToken()).toBeNull();
    expect(state.readOptions).toHaveLength(0);
  });

  it("returns null WITHOUT touching the store when the session has no sid", async () => {
    // A session minted before the token store existed. They live 7 days and
    // outlive the deploy, and they must not cost a query each.
    state.session = { sub: "operator-1", email: "op@tesserix.test", exp: now() + 86_400 };
    seedRow({ accessExpiresAt: new Date(Date.now() + 3_600_000) });

    expect(await getToken()).toBeNull();
    expect(state.readOptions).toHaveLength(0);
    expect(state.refreshCalls).toBe(0);
  });

  it("does NOT fall back to tokens left on the session", async () => {
    // The cookie claims still decode, and reading them would be wrong: a
    // session could only carry them if a browser had accepted the oversized
    // cookie, which is the outage itself.
    state.session = {
      sub: "operator-1",
      exp: now() + 86_400,
      accessToken: "from-the-cookie",
      accessTokenExpiresAt: now() + 3_600,
      refreshToken: "cookie-refresh",
    };

    expect(await getToken()).toBeNull();
  });

  it("returns null when there is no row for the sid", async () => {
    // Logged out, pruned, or the callback could not write one.
    state.row = null;

    expect(await getToken()).toBeNull();
    expect(state.refreshCalls).toBe(0);
  });

  it("serves a comfortably valid token without refreshing or locking", async () => {
    seedRow({ accessToken: "still-good", accessExpiresAt: new Date(Date.now() + 3_600_000) });

    expect(await getToken()).toBe("still-good");
    expect(state.refreshCalls).toBe(0);
    // One read, on the pool, with no lock: the common path must not queue
    // behind a two-connection pool for a token that is valid for another hour.
    expect(state.readOptions).toHaveLength(1);
    expect(state.readOptions[0].query).toBeUndefined();
    expect(state.readOptions[0].forUpdate).toBeFalsy();
    expect(state.maxTxDepth).toBe(0);
  });

  it("renews a token that expires imminently and persists BOTH new tokens", async () => {
    // The window matters: a token valid for another ten seconds has to survive
    // this request, the hop to the platform API, and that service's clock.
    seedRow({ accessToken: "about-to-die", accessExpiresAt: new Date(Date.now() + 10_000) });
    state.refreshResponses = [
      { access_token: "renewed", refresh_token: "rotated-1", expires_in: 3_600 },
    ];

    expect(await getToken()).toBe("renewed");
    expect(state.refreshCalls).toBe(1);

    // The rotated refresh token is written back. This is THE bug the store
    // exists to fix: Zitadel rotates on use, so dropping it makes every later
    // refresh present a spent token.
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].accessToken).toBe("renewed");
    expect(state.saved[0].refreshToken).toBe("rotated-1");
    expect(state.saved[0].accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    // And the row now holds them, so the next caller reads the new pair.
    const rows = state.row as Record<string, Row>;
    expect(rows["sid-1"].accessToken).toBe("renewed");
    expect(rows["sid-1"].refreshToken).toBe("rotated-1");
  });

  it("renews an already-expired token", async () => {
    seedRow({ accessToken: "dead", accessExpiresAt: new Date(Date.now() - 3_600_000) });
    state.refreshResponses = [{ access_token: "renewed", expires_in: 3_600 }];

    expect(await getToken()).toBe("renewed");
  });

  it("keeps the current refresh token when the response carries no replacement", async () => {
    // No rotation happened, so the token we spent is still the live one.
    // Overwriting it with null would strand the session at its next refresh.
    seedRow({ accessExpiresAt: new Date(Date.now() - 1_000), refreshToken: "unrotated" });
    state.refreshResponses = [{ access_token: "renewed", expires_in: 3_600 }];

    await getToken();
    expect(state.saved[0].refreshToken).toBe("unrotated");
  });

  it("takes the lock and joins the write to the SAME transaction", async () => {
    // The store's contract: a caller-supplied `query` is what makes the read,
    // the refresh and the write one atomic unit — and what makes the store
    // rethrow rather than swallow, so a failed write rolls the refresh back.
    seedRow({ accessExpiresAt: new Date(Date.now() - 1_000) });
    state.refreshResponses = [{ access_token: "renewed", expires_in: 3_600 }];

    await getToken();

    expect(state.readOptions).toHaveLength(2);
    // First read: unlocked, on the pool.
    expect(state.readOptions[0].query).toBeUndefined();
    // Second read: inside the transaction, holding the row.
    expect(state.readOptions[1].query).toBe(txQuery);
    expect(state.readOptions[1].forUpdate).toBe(true);
    // The write rides the same transaction.
    expect(state.saveOptions).toHaveLength(1);
    expect(state.saveOptions[0].query).toBe(txQuery);
  });

  it("refreshes ONCE for two concurrent callers, not twice", async () => {
    // THE POINT OF THIS TASK. Zitadel rotates the refresh token on use, so two
    // concurrent refreshes both spend the same one: one wins and the other
    // writes a dead token over the winner's row. Two replicas and parallel RSC
    // renders both produce this, and React's `cache` — request-scoped —
    // prevents neither.
    seedRow({ accessToken: "about-to-die", accessExpiresAt: new Date(Date.now() + 10_000) });
    state.refreshDelayMs = 20;
    state.refreshResponses = [
      { access_token: "renewed", refresh_token: "rotated-1", expires_in: 3_600 },
      // If the lock or the re-check failed, the second caller would spend the
      // already-spent token and get this — a distinct value, so the assertion
      // says WHICH failure happened rather than only that one did.
      { access_token: "double-spent", refresh_token: "rotated-2", expires_in: 3_600 },
    ];

    const { getPlatformApiToken } = await import("./platform-token");
    // Two independent request scopes would be two module registries; the
    // memo is not what is under test here, so call the same one twice and let
    // the fake transaction serialise them.
    const [a, b] = await Promise.all([getPlatformApiToken(), getPlatformApiToken()]);

    expect(state.refreshCalls).toBe(1);
    expect(a).toBe("renewed");
    expect(b).toBe("renewed");
    // Never two transactions in flight at once — the lock is exclusive.
    expect(state.maxTxDepth).toBe(1);
    const rows = state.row as Record<string, Row>;
    expect(rows["sid-1"].refreshToken).toBe("rotated-1");
  });

  it("re-checks inside the lock: a row already refreshed is used as-is", async () => {
    // The waiter's half of the test above, isolated. Whoever held the lock
    // refreshed the row while this caller queued; it must notice on the locked
    // read and spend nothing. Skipping this re-check is the classic
    // double-checked-locking bug, and it reintroduces the double-spend the
    // lock exists to prevent.
    seedRow({ accessToken: "about-to-die", accessExpiresAt: new Date(Date.now() + 10_000) });
    state.refreshedWhileWaiting = true;
    state.refreshResponses = [{ access_token: "must-not-happen", expires_in: 3_600 }];

    expect(await getToken()).toBe("someone-elses-renewal");
    expect(state.refreshCalls).toBe(0);
    expect(state.saved).toHaveLength(0);
    // It did take the lock — the early return is inside the transaction, not
    // instead of it.
    expect(state.readOptions[1].forUpdate).toBe(true);
  });

  it("returns null — never the dead token — when there is nothing to renew with", async () => {
    // Zitadel issues a refresh token only when the application has the Refresh
    // Token grant enabled. Handing back the expired access token would turn a
    // clear local failure into a 401 from a service that has no idea why.
    seedRow({ accessToken: "dead", accessExpiresAt: new Date(Date.now() - 3_600_000), refreshToken: null });

    expect(await getToken()).toBeNull();
    expect(state.refreshCalls).toBe(0);
    expect(state.maxTxDepth).toBe(0);
  });

  it("returns null and leaves the row intact when the refresh is rejected", async () => {
    // A revoked or rotated refresh token. That is "sign in again", not "the
    // console is broken" — and the row must keep the only tokens that could
    // still be valid rather than being cleared.
    seedRow({ accessToken: "dead", accessExpiresAt: new Date(Date.now() - 10_000) });
    state.refreshResponses = [null];

    expect(await getToken()).toBeNull();
    expect(state.saved).toHaveLength(0);
    const rows = state.row as Record<string, Row>;
    expect(rows["sid-1"].accessToken).toBe("dead");
    expect(rows["sid-1"].refreshToken).toBe("refresh-1");
  });

  it("returns null when the refresh succeeds but the write fails", async () => {
    // The store rethrows on the transaction path so the whole thing rolls
    // back. Returning the token anyway would hand out a credential whose
    // rotated refresh partner was never persisted.
    seedRow({ accessExpiresAt: new Date(Date.now() - 10_000) });
    state.refreshResponses = [{ access_token: "renewed", refresh_token: "rotated-1", expires_in: 3_600 }];
    state.saveThrows = true;

    await expect(getToken()).resolves.toBeNull();
  });

  it("returns null rather than throwing when Zitadel is not configured", async () => {
    seedRow({ accessExpiresAt: new Date(Date.now() - 10_000) });
    state.configThrows = true;

    await expect(getToken()).resolves.toBeNull();
    // Checked before the transaction: a misconfiguration must not open one.
    expect(state.maxTxDepth).toBe(0);
  });

  it("returns null rather than throwing when the store is unusable", async () => {
    // No database, or no OPERATOR_TOKEN_ENCRYPT_KEY. The console has to keep
    // serving every surface that never wanted a platform-API token.
    state.storeUnusable = true;

    await expect(getToken()).resolves.toBeNull();
    expect(state.refreshCalls).toBe(0);
  });

  it("returns null rather than throwing when the transaction cannot be opened", async () => {
    seedRow({ accessExpiresAt: new Date(Date.now() - 10_000) });
    state.txThrows = true;

    await expect(getToken()).resolves.toBeNull();
    expect(state.refreshCalls).toBe(0);
  });

  it("gives up on a hung Zitadel rather than holding the row lock", async () => {
    // A network call inside an open transaction holds the row lock for its
    // whole duration, and `fetch` waits a very long time. The deadline unwinds
    // through ROLLBACK, so the lock and the pooled connection come back.
    seedRow({ accessExpiresAt: new Date(Date.now() - 10_000) });
    state.refreshResponses = [{ access_token: "too-late", expires_in: 3_600 }];
    // Longer than the module's 5s deadline.
    state.refreshDelayMs = 60_000;

    // The module is loaded BEFORE the clock is faked: vitest resolves a
    // dynamic import through timers, and faking them first deadlocks the
    // import rather than the code under test.
    const { getPlatformApiToken } = await import("./platform-token");
    vi.useFakeTimers();
    try {
      const pending = getPlatformApiToken();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBeNull();
      // Nothing was written, so the next request retries from a clean row.
      expect(state.saved).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT memoise across requests, which is the property that matters", async () => {
    // React's `cache` is request-scoped, and this environment has no request
    // scope — so a fresh module registry refreshes again. That is exactly
    // right: a module-level memo would be the obvious hand-rolled alternative
    // and it would be a cross-operator token leak. The de-duplication is a
    // performance nicety; NOT sharing tokens between requests is a security
    // property, and it is the one a test can pin here.
    seedRow({ accessExpiresAt: new Date(Date.now() - 10_000) });
    state.refreshResponses = [{ access_token: "renewed-1", refresh_token: "r1", expires_in: 3_600 }];
    expect(await getToken()).toBe("renewed-1");

    // A second "request": fresh module registry, a different operator.
    vi.resetModules();
    state.session = { sub: "operator-2", sid: "sid-2", exp: now() + 86_400 };
    state.row = {
      "sid-2": {
        sub: "operator-2",
        accessToken: "dead-2",
        accessExpiresAt: new Date(Date.now() - 10_000),
        refreshToken: "r2",
        sessionExpiresAt: new Date(Date.now() + 86_400_000),
      },
    };
    state.refreshResponses = [{ access_token: "renewed-for-operator-2", expires_in: 3_600 }];

    expect(await getToken()).toBe("renewed-for-operator-2");
  });
});
