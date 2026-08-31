import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxQuery } from "../db/tesserix";
import type {
  CapabilityReadResult,
  OperatorTokensInput,
  ReadTokensOptions,
  StoredOperatorTokens,
  TokenStoreOptions,
} from "./operator-token-store";

/**
 * THE INTERVAL — tesserix-home#285.
 *
 * `operator.live.test.ts` proves the gate obeys whatever the resolver says.
 * This file proves the resolver asks Zitadel OFTEN ENOUGH, and not more often
 * than that, which is the half of the change that is easy to get quietly
 * wrong: revalidating only when the ACCESS TOKEN is near expiry compiles,
 * passes every other test here, and leaves a TWELVE HOUR revocation window
 * because that is how long the token lives.
 *
 * So the assertions are about WHEN `refreshAccessToken` is called, counted
 * directly. A fresh timestamp must produce ZERO IdP calls; a stale one, and a
 * NULL one, must produce exactly one.
 *
 * The store, the OIDC client and the transaction are doubled — their own
 * behaviour is covered by `operator-token-store.test.ts`,
 * `operator-token-store.integration.test.ts`, `oidc.test.ts` and
 * `platform-token.test.ts`. The transaction double is a real mutex, so the
 * re-check inside the lock is observable rather than assumed.
 */

interface Row {
  sub: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string | null;
  sessionExpiresAt: Date;
  capabilities: string[] | null;
  capabilitiesCheckedAt: Date | null;
}

const SID = "sid-1";
const HOUR = 3_600_000;

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** Set to make the capability read fail the way a database blip does. */
  capabilityReadUnavailable: false,
  refreshCalls: 0,
  /** What `rolesFromAccessToken` answers. `null` is "unreadable token". */
  roles: ["crm"] as string[] | null,
  rolesCalls: 0,
  configThrows: false,
  saved: [] as OperatorTokensInput[],
}));

vi.mock("@tesserix/platform-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tesserix/platform-auth")>();
  return {
    ...actual,
    getCurrentSession: async () => null,
    // The REAL `capabilitiesFor`, not a stub: that the resolver stores the
    // same mapping `/auth/callback` writes is the property keeping the two
    // representations from drifting, and a stub would hide a change to it.
    capabilitiesFor: actual.capabilitiesFor,
    rolesFromAccessToken: async () => {
      state.rolesCalls += 1;
      return state.roles;
    },
  };
});

vi.mock("./oidc", () => ({
  getOidcConfig: () => {
    if (state.configThrows) throw new Error("not configured");
    return {
      issuer: "https://auth.test",
      clientId: "c",
      clientSecret: "s",
      projectId: "project-1",
    };
  },
  refreshAccessToken: async () => {
    state.refreshCalls += 1;
    return {
      access_token: `renewed-${state.refreshCalls}`,
      refresh_token: `rotated-${state.refreshCalls}`,
      expires_in: 43_200,
    };
  },
}));

vi.mock("./operator-token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operator-token-store")>();
  const rows = () => (state.row ?? {}) as Record<string, Row>;
  const mocked = {
    accessTokenExpiresAt: actual.accessTokenExpiresAt,
    readCapabilities: async (sid: string): Promise<CapabilityReadResult> => {
      if (state.capabilityReadUnavailable) {
        return { outcome: "unavailable", capabilities: null, checkedAt: null };
      }
      const row = rows()[sid];
      if (!row) return { outcome: "absent", capabilities: null, checkedAt: null };
      return {
        outcome: "ok",
        capabilities: row.capabilities,
        checkedAt: row.capabilitiesCheckedAt,
      };
    },
    readTokens: async (
      sid: string,
      _options: ReadTokensOptions = {},
    ): Promise<StoredOperatorTokens | null> => {
      const row = rows()[sid];
      if (!row) return null;
      return {
        accessToken: row.accessToken,
        accessExpiresAt: row.accessExpiresAt,
        refreshToken: row.refreshToken,
        capabilities: row.capabilities,
        capabilitiesCheckedAt: row.capabilitiesCheckedAt,
      };
    },
    saveTokens: async (
      sid: string,
      sub: string,
      tokens: OperatorTokensInput,
      sessionExpiresAt: Date,
      _options: TokenStoreOptions = {},
    ): Promise<void> => {
      state.saved.push(tokens);
      const all = rows();
      all[sid] = {
        sub,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshToken: tokens.refreshToken ?? null,
        sessionExpiresAt,
        // The real upsert COALESCEs: `undefined` preserves, an array (empty
        // included) overwrites. Reproduced here because a double that clears
        // on undefined would hide the bug that costs a session its list.
        capabilities: tokens.capabilities
          ? [...tokens.capabilities]
          : (all[sid]?.capabilities ?? null),
        capabilitiesCheckedAt:
          tokens.capabilitiesCheckedAt ?? all[sid]?.capabilitiesCheckedAt ?? null,
      };
      state.row = all;
    },
    readTokenRecord: actual.readTokenRecord,
  };
  return mocked;
});

// A mutex, because that is what `SELECT ... FOR UPDATE` is to this module.
let txChain: Promise<unknown> = Promise.resolve();

vi.mock("../db/tesserix", () => ({
  tesserixTx: async <T>(fn: (query: TxQuery) => Promise<T>): Promise<T> => {
    const run = txChain.then(() => fn((async () => []) as unknown as TxQuery));
    txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  },
  isDatabaseConfigured: () => true,
}));

const { resolveLiveCapabilities, CAPABILITY_REVALIDATE_SECONDS } = await import(
  "./platform-token"
);

const SESSION = {
  sub: "operator-1",
  sid: SID,
  email: "not.on.the.allowlist@example.com",
  exp: Math.floor(Date.now() / 1000) + 7 * 86_400,
};

function seedRow(over: Partial<Row> = {}): void {
  state.row = {
    [SID]: {
      sub: "operator-1",
      accessToken: "stored",
      accessExpiresAt: new Date(Date.now() + 11 * HOUR),
      refreshToken: "refresh-1",
      sessionExpiresAt: new Date(Date.now() + 7 * 24 * HOUR),
      capabilities: ["crm"],
      capabilitiesCheckedAt: new Date(),
      ...over,
    },
  };
}

beforeEach(() => {
  state.row = null;
  state.capabilityReadUnavailable = false;
  state.refreshCalls = 0;
  state.rolesCalls = 0;
  state.roles = ["crm"];
  state.configThrows = false;
  state.saved = [];
  txChain = Promise.resolve();
});

describe("the revalidation interval", () => {
  it("is five minutes, which is the stated acceptance criterion", () => {
    // Pinned deliberately. Raising it silently widens the revocation window
    // #285 exists to close, and the number is quoted in migration 0040.
    expect(CAPABILITY_REVALIDATE_SECONDS).toBe(300);
  });

  it("serves a FRESH list without calling Zitadel at all", async () => {
    seedRow({
      capabilities: ["crm", "support"],
      capabilitiesCheckedAt: new Date(Date.now() - 60_000),
    });

    const resolved = await resolveLiveCapabilities(SESSION);

    expect(resolved).toEqual({
      source: "store",
      capabilities: ["crm", "support"],
    });
    // The common path is one indexed point lookup and nothing else. An IdP
    // round trip in front of every gated mutation is not acceptable.
    expect(state.refreshCalls).toBe(0);
  });

  it("REFRESHES when the list is stale, and does not wait for the token to expire", async () => {
    // The access token here has ELEVEN HOURS left, so `isExpiring` is false and
    // the token path would do nothing. The refresh happens because the
    // CAPABILITIES are stale — that is the difference between a five-minute
    // window and a twelve-hour one.
    seedRow({
      accessExpiresAt: new Date(Date.now() + 11 * HOUR),
      capabilities: ["crm"],
      capabilitiesCheckedAt: new Date(
        Date.now() - (CAPABILITY_REVALIDATE_SECONDS + 60) * 1000,
      ),
    });
    state.roles = ["crm", "hard-delete"];

    const resolved = await resolveLiveCapabilities(SESSION);

    expect(state.refreshCalls).toBe(1);
    expect(resolved).toEqual({
      source: "store",
      capabilities: ["crm", "hard-delete"],
    });
  });

  it("treats a NULL checked-at as STALE, not as an empty grant", async () => {
    // A row written before migration 0040 has no timestamp. Reading it as
    // "holds nothing" would refuse every gated action for every session alive
    // at deploy time.
    seedRow({ capabilities: null, capabilitiesCheckedAt: null });
    state.roles = ["crm"];

    const resolved = await resolveLiveCapabilities(SESSION);

    expect(state.refreshCalls).toBe(1);
    expect(resolved).toEqual({ source: "store", capabilities: ["crm"] });
  });

  it("treats a FUTURE checked-at as stale, so clock skew cannot pin a list open", async () => {
    seedRow({ capabilitiesCheckedAt: new Date(Date.now() + 10 * HOUR) });

    await resolveLiveCapabilities(SESSION);

    expect(state.refreshCalls).toBe(1);
  });

  it("stamps a fresh checked-at, so the next call inside the window is free", async () => {
    seedRow({ capabilitiesCheckedAt: null });

    await resolveLiveCapabilities(SESSION);
    expect(state.refreshCalls).toBe(1);

    await resolveLiveCapabilities(SESSION);
    expect(state.refreshCalls).toBe(1);
  });

  it("revalidates ONCE when two callers arrive together", async () => {
    // The lock plus the re-check inside it. Without the re-check the waiter
    // spends the refresh token a second time, and Zitadel treats a reused
    // refresh token as theft — see `renewUnderLock`'s docstring.
    seedRow({ capabilitiesCheckedAt: null });

    await Promise.all([
      resolveLiveCapabilities(SESSION),
      resolveLiveCapabilities(SESSION),
    ]);

    expect(state.refreshCalls).toBe(1);
  });

  it("stores an EMPTY list when every grant is gone, and refuses thereafter", async () => {
    // The revocation, end to end at this layer: Zitadel now reports no roles,
    // and `[]` is written as a real answer with a fresh timestamp rather than
    // left as "unknown".
    seedRow({
      capabilities: ["crm", "hard-delete"],
      capabilitiesCheckedAt: null,
    });
    state.roles = [];

    const resolved = await resolveLiveCapabilities(SESSION);

    expect(resolved).toEqual({ source: "store", capabilities: [] });
    expect(state.saved.at(-1)?.capabilities).toEqual([]);
    expect(state.saved.at(-1)?.capabilitiesCheckedAt).toBeInstanceOf(Date);
  });
});

describe("what happens when the answer cannot be had", () => {
  it("reports store-unavailable rather than an empty grant", async () => {
    state.capabilityReadUnavailable = true;

    expect(await resolveLiveCapabilities(SESSION)).toEqual({
      source: "unavailable",
      reason: "store-unavailable",
    });
    expect(state.refreshCalls).toBe(0);
  });

  it("reports no-sid for a session minted before the token store", async () => {
    expect(
      await resolveLiveCapabilities({ sub: "operator-1" }),
    ).toEqual({ source: "unavailable", reason: "no-sid" });
    expect(state.refreshCalls).toBe(0);
  });

  it("reports no-row, and does not try to refresh what it cannot read", async () => {
    // The refresh token lives in the row that is not there.
    state.row = {};

    expect(await resolveLiveCapabilities(SESSION)).toEqual({
      source: "unavailable",
      reason: "no-row",
    });
    expect(state.refreshCalls).toBe(0);
  });

  it("reports not-configured WITHOUT opening a transaction", async () => {
    seedRow({ capabilitiesCheckedAt: null });
    state.configThrows = true;

    expect(await resolveLiveCapabilities(SESSION)).toEqual({
      source: "unavailable",
      reason: "not-configured",
    });
    expect(state.refreshCalls).toBe(0);
  });

  it("PERSISTS THE ROTATED REFRESH TOKEN even when the roles cannot be read", async () => {
    // By this point the refresh token has already been spent. Dropping its
    // replacement would cost the session its ability to refresh at all,
    // turning a failed capability read into a forced sign-in.
    seedRow({
      capabilities: ["crm"],
      capabilitiesCheckedAt: null,
      refreshToken: "refresh-1",
    });
    state.roles = null;

    const resolved = await resolveLiveCapabilities(SESSION);

    expect(resolved).toEqual({
      source: "unavailable",
      reason: "revalidation-failed",
    });
    expect(state.saved.at(-1)?.refreshToken).toBe("rotated-1");
    // And the previous list is PRESERVED, not cleared: `undefined` means "did
    // not ask", which the upsert COALESCEs away.
    expect(state.saved.at(-1)?.capabilities).toBeUndefined();
    expect((state.row?.[SID] as Row).capabilities).toEqual(["crm"]);
  });

  it("does not stamp a fresh checked-at when the roles could not be read", async () => {
    // Advancing the timestamp on a failed read would claim freshness for a
    // list nobody confirmed, and buy the stale list another five minutes.
    seedRow({ capabilities: ["crm"], capabilitiesCheckedAt: null });
    state.roles = null;

    await resolveLiveCapabilities(SESSION);

    expect((state.row?.[SID] as Row).capabilitiesCheckedAt).toBeNull();
  });

  it("cannot revalidate a row with no refresh token, and says so", async () => {
    seedRow({ refreshToken: null, capabilitiesCheckedAt: null });

    expect(await resolveLiveCapabilities(SESSION)).toEqual({
      source: "unavailable",
      reason: "revalidation-failed",
    });
    expect(state.refreshCalls).toBe(0);
  });
});
