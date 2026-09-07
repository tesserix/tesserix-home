import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The startup schema preflight.
 *
 * ══ THE TESTS THAT MATTER HERE ARE THE FAILURES ══
 *
 * The check itself is trivial — a subset test over two sets of integers.
 * Everything that makes it worth building is in what it does when it fires,
 * and in the paths where a lenient implementation would quietly succeed. A
 * preflight that passes on an unreachable database, a missing version file or
 * an unparseable one is WORSE THAN NOT HAVING ONE: it converts a loud failure
 * into a green one, which is precisely the defect it exists to prevent. So
 * every one of those paths has its own case below, and each asserts a
 * non-zero code rather than merely "not EXIT_OK".
 *
 * The happy path is here too, but it is the cheap half.
 *
 * `readAppliedVersions` is exercised against a REAL `schema_migrations` table
 * in an in-process Postgres (pglite), following
 * `lib/db/promo-codes.integration.test.ts`. A hand-written stub returning
 * `[{version: 51}]` would assert the shape this file already assumes rather
 * than the shape the runner actually writes — and the runner's DDL is the
 * contract being read.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@/lib/db/tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    isDatabaseConfigured: () => true,
    closeTesserixPool: async () => {},
  };
});

const {
  DEFAULT_VERSION_FILE,
  EXIT_OK,
  EXIT_PREFLIGHT_FAILED,
  EXIT_SCHEMA_BEHIND,
  readAppliedVersions,
  readExpectedVersions,
  runSchemaPreflight,
} = await import("./require-schema-version");

const CONSOLE_DIR = path.resolve(__dirname, "..");

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "schema-preflight-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a version file and return its path. `body` is written verbatim so a
 *  test can produce malformed JSON as easily as valid JSON. */
function versionFile(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  writeFileSync(file, body, "utf8");
  return file;
}

function versionsFile(name: string, versions: unknown[]): string {
  return versionFile(name, JSON.stringify({ maxVersion: versions.at(-1), versions }));
}

/** Capture stdout/stderr so the MESSAGE can be asserted, not just the code.
 *  Someone reads these lines at 2am during a stalled rollout; a correct exit
 *  code with an unusable message is only half of this feature. */
let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    out.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    err.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const applied = (...versions: number[]) => async () => new Set(versions);

describe("runSchemaPreflight — the comparison", () => {
  it("starts when the ledger holds every version the image ships", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("equal.json", [49, 50, 51]),
      readApplied: applied(49, 50, 51),
    });

    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("0051");
  });

  /**
   * AHEAD IS A PASS, and this is the case a naive equality check gets wrong.
   *
   * After a migration lands, the currently-running OLDER image must keep
   * serving — that is the entire rollout window the migrations are written
   * for. An image that refused to start against a database ahead of it would
   * turn every migration into an outage of the running version.
   */
  it("starts when the database is AHEAD of the image", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("behind-db.json", [49, 50, 51]),
      readApplied: applied(49, 50, 51, 52, 53),
    });

    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    // Said out loud, so a reader seeing 0053 in a log for an image that ships
    // 0051 does not have to wonder whether it was tolerated or missed.
    expect(out.join("\n")).toContain("ahead");
  });

  it("refuses when the database is BEHIND the image", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("ahead-image.json", [49, 50, 51]),
      readApplied: applied(49),
    });

    expect(code).toBe(EXIT_SCHEMA_BEHIND);
  });

  /**
   * A HOLE, not a shortfall — the 2026-09-07 shape.
   *
   * `0051` was applied by piping the file through `psql`, so the DDL landed
   * and `schema_migrations` was never written. A check that compared MAXIMA
   * would call this healthy the moment any later migration was recorded, which
   * is why the baked artefact carries the whole list.
   */
  it("names a missing version even when the ledger's maximum is high enough", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("hole.json", [49, 50, 51, 52]),
      readApplied: applied(49, 50, 52),
    });

    expect(code).toBe(EXIT_SCHEMA_BEHIND);
    expect(err.join("\n")).toContain("0051");
  });
});

describe("runSchemaPreflight — the failure message", () => {
  it("names every missing version, in migration-filename form", async () => {
    await runSchemaPreflight({
      versionFile: versionsFile("message.json", [49, 50, 51]),
      readApplied: applied(49),
    });

    const message = err.join("\n");
    // Zero-padded, because the reader has to go find `0050_*.sql` on disk.
    expect(message).toContain("0050");
    expect(message).toContain("0051");
    // …and not the ones that ARE applied, which would send them looking for a
    // migration that is already recorded.
    expect(message).not.toContain("0049");
  });

  it("says how to fix it — the runner, by path", async () => {
    await runSchemaPreflight({
      versionFile: versionsFile("fix.json", [51]),
      readApplied: applied(),
    });

    const message = err.join("\n");
    expect(message).toContain("apps/web/scripts/db-migrate.mjs");
    // The trap that produced failure 2 on 2026-09-07. Whoever reads this
    // message is the person about to reach for psql.
    expect(message).toMatch(/psql/i);
  });
});

describe("runSchemaPreflight — an unverifiable database is NOT a pass", () => {
  it("refuses when the ledger cannot be read", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("unreachable.json", [51]),
      readApplied: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
          code: "ECONNREFUSED",
        });
      },
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
    expect(code).not.toBe(EXIT_OK);
  });

  it("reports the error's code without echoing its message", async () => {
    await runSchemaPreflight({
      versionFile: versionsFile("leak.json", [51]),
      readApplied: async () => {
        throw Object.assign(
          new Error("password authentication failed for user tesserix_admin"),
          { code: "28P01" },
        );
      },
    });

    const message = err.join("\n");
    // The diagnostic half…
    expect(message).toContain("28P01");
    // …without the half that names the role, because this line goes to the
    // cluster's log sink. Same trade-off `parity-check.ts` makes.
    expect(message).not.toContain("tesserix_admin");
  });

  it("refuses when the connection is not configured at all", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("unconfigured.json", [51]),
      databaseConfigured: () => false,
      readApplied: async () => {
        throw new Error("must not be reached");
      },
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
    expect(err.join("\n")).toContain("TESSERIX_DB_HOST");
  });
});

describe("runSchemaPreflight — a broken version file is NOT a pass", () => {
  it("refuses when the version file is absent", async () => {
    const code = await runSchemaPreflight({
      versionFile: path.join(tmpDir, "does-not-exist.json"),
      readApplied: applied(1, 2, 3),
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
  });

  it("refuses when the version file is not JSON", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionFile("garbage.json", "{ this is not json"),
      readApplied: applied(1, 2, 3),
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
  });

  /**
   * The most dangerous malformation, because it is the one that LOOKS valid.
   * An empty list makes the subset test trivially true, so the preflight would
   * pass against an entirely empty database.
   */
  it("refuses when the version file lists no migrations", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("empty.json", []),
      readApplied: applied(),
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
  });

  it("refuses when a version is not a positive integer", async () => {
    for (const bad of [["51"], [51.5], [0], [-1], [null]]) {
      const code = await runSchemaPreflight({
        versionFile: versionsFile(`bad-${String(bad[0])}.json`, bad),
        readApplied: applied(51),
      });
      expect(code).toBe(EXIT_PREFLIGHT_FAILED);
    }
  });

  it("refuses when the object has no versions array", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionFile("no-array.json", JSON.stringify({ maxVersion: 51 })),
      readApplied: applied(51),
    });

    expect(code).toBe(EXIT_PREFLIGHT_FAILED);
  });

  it("points at the BUILD rather than sending anyone to run migrations", async () => {
    await runSchemaPreflight({
      versionFile: path.join(tmpDir, "also-absent.json"),
      readApplied: applied(),
    });

    const message = err.join("\n");
    expect(message).toContain("build:schema-version");
    expect(message).toContain("Do not run migrations");
  });
});

/**
 * The ledger, read from a real `schema_migrations` — the DDL
 * `apps/web/scripts/db-migrate.mjs` creates, verbatim.
 */
describe("readAppliedVersions — against a real Postgres", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    dbHolder.db = db;
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version    integer      PRIMARY KEY,
          name       text         NOT NULL,
          applied_at timestamptz  NOT NULL DEFAULT now()
      )
    `);
    await db.exec(`
      INSERT INTO schema_migrations (version, name)
      VALUES (49, 'crm_opportunities_voided'), (50, 'login_totp_cooldown')
    `);
  });

  afterAll(async () => {
    dbHolder.db = undefined;
    await db.close();
  });

  it("reads the versions as NUMBERS, whatever the driver decodes them as", async () => {
    const versions = await readAppliedVersions();

    // `.has(50)` is the operation the whole check rests on, and a string "50"
    // in the set would silently never match — every startup would then report
    // every migration missing, on a database that is perfectly up to date.
    expect(versions.has(50)).toBe(true);
    expect([...versions].every((v) => typeof v === "number")).toBe(true);
  });

  it("drives a real end-to-end refusal off that table", async () => {
    const code = await runSchemaPreflight({
      versionFile: versionsFile("real.json", [49, 50, 51]),
    });

    expect(code).toBe(EXIT_SCHEMA_BEHIND);
    expect(err.join("\n")).toContain("0051");
  });

  it("passes once the missing version is recorded", async () => {
    await db.exec(
      `INSERT INTO schema_migrations (version, name) VALUES (51, 'promo_codes_scoping')`,
    );

    const code = await runSchemaPreflight({
      versionFile: versionsFile("real-ok.json", [49, 50, 51]),
    });

    expect(code).toBe(EXIT_OK);
  });

  it("refuses when there is no ledger table at all", async () => {
    const bare = new PGlite();
    const previous = dbHolder.db;
    dbHolder.db = bare;
    try {
      const code = await runSchemaPreflight({
        versionFile: versionsFile("no-table.json", [51]),
      });
      // A database with no `schema_migrations` has certainly not been migrated
      // by the runner. `42P01` must not be swallowed into a pass.
      expect(code).toBe(EXIT_PREFLIGHT_FAILED);
    } finally {
      dbHolder.db = previous;
      await bare.close();
    }
  });
});

/**
 * T1 against T2: the artefact the build emits has to be the artefact the
 * preflight reads.
 *
 * Both halves run for real — the emitter as a subprocess over the actual
 * `apps/web/db/migrations/` directory, the reader over its output. A test that
 * hand-wrote the JSON would pin this file's assumption about the format rather
 * than the format, and the two could then drift without anything failing until
 * a pod crash-looped in the cluster.
 */
describe("emit-schema-version.mjs -> readExpectedVersions", () => {
  it("emits a file the preflight can read, covering every migration on disk", async () => {
    const out = path.join(tmpDir, "emitted.json");
    execFileSync(process.execPath, ["scripts/emit-schema-version.mjs", out], {
      cwd: CONSOLE_DIR,
      stdio: "pipe",
    });

    const versions = await readExpectedVersions(out);

    expect(versions.length).toBeGreaterThan(0);
    // 0051 exists today and is the migration whose absence started all this.
    expect(versions).toContain(51);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("agrees with the migration files actually present", async () => {
    const out = path.join(tmpDir, "emitted-2.json");
    execFileSync(process.execPath, ["scripts/emit-schema-version.mjs", out], {
      cwd: CONSOLE_DIR,
      stdio: "pipe",
    });

    const { listMigrationFiles } = await import("../../web/scripts/migration-files.mjs");
    const onDisk = (await listMigrationFiles()).map((f: { version: number }) => f.version);

    expect(await readExpectedVersions(out)).toEqual(onDisk);
  });
});

describe("DEFAULT_VERSION_FILE", () => {
  /**
   * The bundle and the JSON are copied into the SAME directory by
   * `Dockerfile.console`, and the bundle resolves the JSON from its own
   * `import.meta.url` rather than from `process.cwd()` — the container's
   * working directory is the standalone root `/app`, two levels above.
   */
  it("sits beside the module that reads it", () => {
    expect(DEFAULT_VERSION_FILE.href).toBe(
      new URL("./schema-version.json", import.meta.url).href,
    );
  });
});
