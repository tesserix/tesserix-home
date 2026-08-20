import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the crypto and the degrade behaviour of the operator token
 * store. The SQL itself is covered against a real Postgres in
 * `operator-token-store.integration.test.ts`; what is proven here is what no
 * database can prove — that the envelope authenticates, that the IV is fresh
 * every time, and that a console with no key or no database keeps serving.
 */

const dbConfigured = vi.hoisted(() => ({ value: true }));
const queries = vi.hoisted(() => ({
  calls: [] as { sql: string; params: readonly unknown[] }[],
  fail: false,
}));

vi.mock("../db/tesserix", () => ({
  isDatabaseConfigured: () => dbConfigured.value,
  tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
    queries.calls.push({ sql, params });
    if (queries.fail) throw new Error("connection terminated");
    return [];
  },
}));

const KEY = "0123456789abcdef0123456789abcdef"; // 32 ASCII chars, as provisioned

const {
  encryptToken,
  decryptToken,
  readTokens,
  saveTokens,
  deleteTokens,
  pruneExpired,
} = await import("./operator-token-store");

beforeEach(() => {
  process.env.OPERATOR_TOKEN_ENCRYPT_KEY = KEY;
  dbConfigured.value = true;
  queries.calls = [];
  queries.fail = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const token = "ya29.a0AfB_byExampleAccessTokenValue";
    const envelope = encryptToken(token);
    expect(envelope).not.toBeNull();
    expect(decryptToken(envelope)).toBe(token);
  });

  it("round-trips a long token and a token with non-ASCII bytes", () => {
    const long = "x".repeat(4096);
    expect(decryptToken(encryptToken(long))).toBe(long);
    const unicode = "tökén-✓- -end";
    expect(decryptToken(encryptToken(unicode))).toBe(unicode);
  });

  it("lays the envelope out as iv || tag || ciphertext", () => {
    const envelope = encryptToken("abc")!;
    // 12-byte IV + 16-byte tag + 3 bytes of ciphertext (GCM is a stream mode,
    // so the ciphertext is exactly as long as the plaintext).
    expect(envelope.length).toBe(12 + 16 + 3);
  });

  it("uses a FRESH iv: the same plaintext encrypts to different bytes", () => {
    const token = "identical-plaintext";
    const a = encryptToken(token)!;
    const b = encryptToken(token)!;
    expect(a.equals(b)).toBe(false);
    // Specifically the IV differs — that is the property GCM's security rests
    // on, not merely that the buffers are unequal somewhere.
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    // And both still decrypt.
    expect(decryptToken(a)).toBe(token);
    expect(decryptToken(b)).toBe(token);
  });

  it("returns null when a byte of the AUTH TAG is flipped", () => {
    const envelope = encryptToken("secret-token")!;
    const tampered = Buffer.from(envelope);
    tampered[12] ^= 0x01; // first byte of the tag
    expect(decryptToken(tampered)).toBeNull();
  });

  it("returns null when a byte of the CIPHERTEXT BODY is flipped", () => {
    const envelope = encryptToken("secret-token")!;
    const tampered = Buffer.from(envelope);
    tampered[12 + 16] ^= 0x01; // first byte of the ciphertext
    expect(decryptToken(tampered)).toBeNull();
  });

  it("returns null when a byte of the IV is flipped", () => {
    const envelope = encryptToken("secret-token")!;
    const tampered = Buffer.from(envelope);
    tampered[0] ^= 0x01;
    expect(decryptToken(tampered)).toBeNull();
  });

  it("returns null for a truncated buffer, at every length", () => {
    const envelope = encryptToken("secret-token")!;
    for (let len = 0; len < envelope.length; len++) {
      expect(decryptToken(envelope.subarray(0, len))).toBeNull();
    }
  });

  it("returns null under a different key — no partial plaintext", () => {
    const envelope = encryptToken("secret-token")!;
    process.env.OPERATOR_TOKEN_ENCRYPT_KEY = "ffffffffffffffffffffffffffffffff";
    expect(decryptToken(envelope)).toBeNull();
  });

  it("accepts a Uint8Array, which is what pglite hands back for bytea", () => {
    const envelope = encryptToken("secret-token")!;
    expect(decryptToken(new Uint8Array(envelope))).toBe("secret-token");
  });

  it("derives a usable key from ANY key length, like session-jwt does", () => {
    for (const key of ["short", "0123456789abcdef0123456789abcdef", "x".repeat(200)]) {
      process.env.OPERATOR_TOKEN_ENCRYPT_KEY = key;
      expect(decryptToken(encryptToken("t"))).toBe("t");
    }
  });

  it("returns null from both halves when the key is missing or empty", () => {
    delete process.env.OPERATOR_TOKEN_ENCRYPT_KEY;
    expect(encryptToken("t")).toBeNull();
    process.env.OPERATOR_TOKEN_ENCRYPT_KEY = KEY;
    const envelope = encryptToken("t")!;
    delete process.env.OPERATOR_TOKEN_ENCRYPT_KEY;
    expect(decryptToken(envelope)).toBeNull();
    process.env.OPERATOR_TOKEN_ENCRYPT_KEY = "";
    expect(encryptToken("t")).toBeNull();
    expect(decryptToken(envelope)).toBeNull();
  });

  it("returns null for a null envelope — the nullable refresh_token column", () => {
    expect(decryptToken(null)).toBeNull();
  });
});

describe("degrades when the key is missing", () => {
  beforeEach(() => {
    delete process.env.OPERATOR_TOKEN_ENCRYPT_KEY;
    // The store now says so out loud (once per process). Silenced here so the
    // suite output stays readable; the warning itself is asserted below,
    // against a freshly imported module so the once-flag is unset.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("readTokens returns null and issues no query", async () => {
    expect(await readTokens("sid-1")).toBeNull();
    expect(queries.calls).toHaveLength(0);
  });

  it("saveTokens does nothing and issues no query", async () => {
    await expect(
      saveTokens(
        "sid-1",
        "sub-1",
        { accessToken: "a", accessExpiresAt: new Date(), refreshToken: "r" },
        new Date(),
      ),
    ).resolves.toBeUndefined();
    expect(queries.calls).toHaveLength(0);
  });

  it("deleteTokens STILL RUNS — deleting a row needs no key", async () => {
    // Deliberately the opposite of what this pinned before. Removing a
    // credential must not depend on being able to read it: gated on the key,
    // the first key rotation would silently stop logout revoking anything, and
    // every signed-out operator's tokens would sit in the table until the
    // sweep. Same rule as `pruneExpired` below.
    await expect(deleteTokens("sid-1")).resolves.toBeUndefined();
    expect(queries.calls).toHaveLength(1);
    expect(queries.calls[0]!.sql).toContain("DELETE FROM operator_api_tokens");
    expect(queries.calls[0]!.params).toEqual(["sid-1"]);
  });

  it("pruneExpired still runs — deleting a row needs no key", async () => {
    await expect(pruneExpired()).resolves.toBeUndefined();
    expect(queries.calls).toHaveLength(1);
  });
});

describe("degrades when the database is not configured", () => {
  beforeEach(() => {
    dbConfigured.value = false;
  });

  it("readTokens returns null and issues no query", async () => {
    expect(await readTokens("sid-1")).toBeNull();
    expect(queries.calls).toHaveLength(0);
  });

  it("saveTokens, deleteTokens and pruneExpired are silent no-ops", async () => {
    await expect(
      saveTokens(
        "sid-1",
        "sub-1",
        { accessToken: "a", accessExpiresAt: new Date(), refreshToken: null },
        new Date(),
      ),
    ).resolves.toBeUndefined();
    await expect(deleteTokens("sid-1")).resolves.toBeUndefined();
    await expect(pruneExpired()).resolves.toBeUndefined();
    expect(queries.calls).toHaveLength(0);
  });
});

describe("degrades when the database throws", () => {
  const failing = () => Promise.reject(new Error("connection terminated"));

  it("every pool-path call degrades rather than throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    queries.fail = true;
    expect(await readTokens("sid-1")).toBeNull();
    await expect(
      saveTokens(
        "sid-1",
        "sub-1",
        { accessToken: "a", accessExpiresAt: new Date(), refreshToken: null },
        new Date(),
      ),
    ).resolves.toBeUndefined();
    await expect(deleteTokens("sid-1")).resolves.toBeUndefined();
    await expect(pruneExpired()).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("a caller-supplied transaction query gets the error, so it can roll back", async () => {
    await expect(
      readTokens("sid-1", { query: failing as never }),
    ).rejects.toThrow("connection terminated");
    await expect(
      saveTokens(
        "sid-1",
        "sub-1",
        { accessToken: "a", accessExpiresAt: new Date(), refreshToken: null },
        new Date(),
        { query: failing as never },
      ),
    ).rejects.toThrow("connection terminated");
    await expect(
      deleteTokens("sid-1", { query: failing as never }),
    ).rejects.toThrow("connection terminated");
  });
});

describe("what reaches the logs", () => {
  it("never names a token, a ciphertext, or the key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const accessToken = "ya29.SUPER-SECRET-ACCESS-TOKEN";
    const envelope = encryptToken(accessToken)!;
    const tampered = Buffer.from(envelope);
    tampered[12] ^= 0x01;

    const rows = [
      {
        access_token: tampered,
        access_expires_at: new Date(),
        refresh_token: null,
      },
    ];
    expect(
      await readTokens("sid-log", { query: (async () => rows) as never }),
    ).toBeNull();

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("sid-log");
    expect(logged).not.toContain(accessToken);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(envelope.toString("hex"));
    error.mockRestore();
  });
});

describe("the SQL the store issues", () => {
  it("locks the row only inside a transaction", async () => {
    const seen: string[] = [];
    const query = (async (sql: string) => {
      seen.push(sql);
      return [];
    }) as never;
    await readTokens("sid-1", { query, forUpdate: true });
    expect(seen[0]).toContain("FOR UPDATE");

    // Outside a transaction FOR UPDATE locks nothing, so it is not emitted:
    // no caller should be able to read safety into a statement that has none.
    await readTokens("sid-1", { forUpdate: true });
    expect(queries.calls[0]?.sql).not.toContain("FOR UPDATE");
  });

  it("upserts on sid, and prunes opportunistically after the write", async () => {
    await saveTokens(
      "sid-1",
      "sub-1",
      { accessToken: "a", accessExpiresAt: new Date(), refreshToken: "r" },
      new Date(),
    );
    expect(queries.calls).toHaveLength(2);
    expect(queries.calls[0].sql).toContain("ON CONFLICT (sid) DO UPDATE");
    expect(queries.calls[1].sql).toContain("session_expires_at < now()");
  });

  it("stores ciphertext, never the plaintext token, as the bound parameter", async () => {
    await saveTokens(
      "sid-1",
      "sub-1",
      {
        accessToken: "plaintext-access",
        accessExpiresAt: new Date(),
        refreshToken: "plaintext-refresh",
      },
      new Date(),
    );
    const params = queries.calls[0].params as unknown[];
    const access = params[2] as Buffer;
    const refresh = params[4] as Buffer;
    expect(Buffer.isBuffer(access)).toBe(true);
    expect(access.toString("utf8")).not.toContain("plaintext-access");
    expect(refresh.toString("utf8")).not.toContain("plaintext-refresh");
    expect(decryptToken(access)).toBe("plaintext-access");
    expect(decryptToken(refresh)).toBe("plaintext-refresh");
  });

  it("does NOT prune inside a transaction, even when the prune would throw", async () => {
    // The regression this guards: the INSERT succeeds, the sweep throws, and
    // because the transaction path rethrows, the caller rolls back the token it
    // just refreshed — then spends an already-spent, already-rotated refresh
    // token on its next attempt. The earlier tx-error test cannot catch this:
    // it rejects on the FIRST statement, so the INSERT-ok/prune-fails path
    // never runs.
    const seen: string[] = [];
    const query = (async (sql: string) => {
      seen.push(sql);
      if (sql.includes("DELETE")) throw new Error("prune blew up");
      return [];
    }) as never;

    await expect(
      saveTokens(
        "sid-tx",
        "sub-1",
        { accessToken: "a", accessExpiresAt: new Date(), refreshToken: "r" },
        new Date(),
        { query },
      ),
    ).resolves.toBeUndefined();

    // Exactly one statement: the upsert. No sweep was even attempted, so there
    // was nothing to throw and nothing to roll the upsert back. This also keeps
    // the table-wide DELETE out of the refresh path's row lock, where two
    // concurrent refreshes could take locks in opposite orders and deadlock.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("INSERT INTO operator_api_tokens");
  });

  it("binds null for an absent refresh token rather than encrypting an empty string", async () => {
    await saveTokens(
      "sid-1",
      "sub-1",
      { accessToken: "a", accessExpiresAt: new Date(), refreshToken: null },
      new Date(),
    );
    expect((queries.calls[0].params as unknown[])[4]).toBeNull();
  });
});

describe("says so when the key is missing but the database is not", () => {
  /**
   * The silent-no-op case is the whole reason this warning exists: database
   * configured, key absent, nothing throws, login succeeds, table stays empty
   * forever, and every platform-API call reports "unreachable" with nothing
   * connecting the two. That is the same invisibility as the outage the table
   * was built to fix.
   *
   * Imported fresh per test because the warning is once-per-process by design
   * (`isStoreUsable` runs on every render); the module-level flag has to start
   * unset for the assertion to mean anything.
   */
  async function freshStore() {
    vi.resetModules();
    return import("./operator-token-store");
  }

  beforeEach(() => {
    delete process.env.OPERATOR_TOKEN_ENCRYPT_KEY;
  });

  it("warns once, no matter how many calls a render makes", async () => {
    const store = await freshStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await store.readTokens("sid-1");
    await store.readTokens("sid-2");
    await store.readTokens("sid-3");

    const warnings = error.mock.calls.filter((call) =>
      String(call[0]).includes("OPERATOR_TOKEN_ENCRYPT_KEY"),
    );
    expect(warnings).toHaveLength(1);
    // Never the key, never a fragment of it, never its length.
    expect(String(warnings[0]![0])).not.toContain(KEY);
  });

  it("stays quiet when the database is not configured either", async () => {
    // A console with neither is simply not running the store — the ordinary
    // local-dev state. Warning about it would train everyone to ignore the
    // line that matters.
    dbConfigured.value = false;
    const store = await freshStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await store.readTokens("sid-1");

    expect(error).not.toHaveBeenCalled();
  });
});
