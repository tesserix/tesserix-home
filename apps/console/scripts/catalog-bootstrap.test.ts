import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  closeTesserixPool: vi.fn(async () => {}),
}));

const bootstrapMock = vi.hoisted(() => ({ runBootstrap: vi.fn() }));
vi.mock("@/lib/billing/bootstrap", () => ({
  runBootstrap: bootstrapMock.runBootstrap,
}));

import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  EXIT_FAILED,
  EXIT_OK,
  parseDryRun,
  parseForce,
  parseMode,
  runCatalogBootstrapJob,
} from "./catalog-bootstrap";

/**
 * The bootstrap's CLI entry point — a caller, not an implementation. Every
 * decision about WHAT gets created lives in `lib/billing/bootstrap.ts` and is
 * shared with nothing else, because there is nothing else that runs a
 * bootstrap; what this file owns is argv parsing, exit codes, one log line,
 * and letting the process end — mirroring `scripts/parity-check.ts` exactly.
 */

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  bootstrapMock.runBootstrap.mockResolvedValue({ productsCreated: 3, pricesCreated: 42, skipped: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseMode", () => {
  it("reads --mode=test", () => {
    expect(parseMode(["--mode=test"])).toBe("test");
  });

  it("reads --mode=live", () => {
    expect(parseMode(["--mode=live"])).toBe("live");
  });

  it("throws when --mode is missing", () => {
    expect(() => parseMode([])).toThrow(/--mode/);
  });

  it("throws on a mode Stripe does not have", () => {
    expect(() => parseMode(["--mode=sandbox"])).toThrow(/test|live/);
  });
});

describe("parseForce", () => {
  it("is false without --force", () => {
    expect(parseForce(["--mode=test"])).toBe(false);
  });

  it("is true with --force", () => {
    expect(parseForce(["--mode=test", "--force"])).toBe(true);
  });
});

describe("parseDryRun", () => {
  it("is false without --dry-run", () => {
    expect(parseDryRun(["--mode=test"])).toBe(false);
  });

  it("is true with --dry-run", () => {
    expect(parseDryRun(["--mode=test", "--dry-run"])).toBe(true);
  });

  it("composes with --force rather than replacing it", () => {
    expect(parseDryRun(["--mode=test", "--force", "--dry-run"])).toBe(true);
    expect(parseForce(["--mode=test", "--force", "--dry-run"])).toBe(true);
  });
});

describe("runCatalogBootstrapJob", () => {
  it("refuses before touching Stripe when the database isn't configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const code = await runCatalogBootstrapJob(["--mode=test"]);

    expect(code).toBe(EXIT_FAILED);
    expect(bootstrapMock.runBootstrap).not.toHaveBeenCalled();
  });

  it("exits 0 and calls runBootstrap with the parsed mode", async () => {
    const code = await runCatalogBootstrapJob(["--mode=test"]);

    expect(code).toBe(EXIT_OK);
    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("test", { force: false, dryRun: false });
  });

  it("forwards --force through to runBootstrap", async () => {
    await runCatalogBootstrapJob(["--mode=live", "--force"]);

    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("live", { force: true, dryRun: false });
  });

  it("forwards --dry-run through to runBootstrap, and composes with --mode rather than replacing it", async () => {
    const code = await runCatalogBootstrapJob(["--mode=test", "--dry-run"]);

    expect(code).toBe(EXIT_OK);
    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("test", { force: false, dryRun: true });
  });

  it("a real run (no --dry-run) still writes, so the flag defaults off", async () => {
    // `runBootstrap` itself is mocked here (this file's job is the CLI
    // layer, not the write path — see `bootstrap.test.ts`'s own `dryRun`
    // suite for the structural "no write happened" proof against the
    // injected Stripe writer), so this only proves the CLI wires the flag's
    // default correctly: no `--dry-run` on argv means `dryRun: false` reaches
    // `runBootstrap`.
    await runCatalogBootstrapJob(["--mode=test"]);

    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("test", { force: false, dryRun: false });
  });

  it("--dry-run composes with --force, reporting a forced run rather than refusing", async () => {
    await runCatalogBootstrapJob(["--mode=live", "--force", "--dry-run"]);

    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("live", { force: true, dryRun: true });
  });

  it("exits non-zero, without throwing, when --mode is missing", async () => {
    const code = await runCatalogBootstrapJob([]);

    expect(code).toBe(EXIT_FAILED);
    expect(bootstrapMock.runBootstrap).not.toHaveBeenCalled();
  });

  it("exits non-zero when runBootstrap rejects, e.g. the populated-mode guard", async () => {
    bootstrapMock.runBootstrap.mockRejectedValue(new Error("bootstrap: test mode already holds 42 mark8ly_ price(s)"));

    const code = await runCatalogBootstrapJob(["--mode=test"]);

    expect(code).toBe(EXIT_FAILED);
  });

  it("always closes the database pool, even on failure", async () => {
    bootstrapMock.runBootstrap.mockRejectedValue(new Error("boom"));

    await runCatalogBootstrapJob(["--mode=test"]);

    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("never lets a pool-close failure mask the job's own outcome", async () => {
    vi.mocked(closeTesserixPool).mockRejectedValue(new Error("pool already closed"));

    const code = await runCatalogBootstrapJob(["--mode=test"]);

    expect(code).toBe(EXIT_OK);
  });
});
