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
    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("test", { force: false });
  });

  it("forwards --force through to runBootstrap", async () => {
    await runCatalogBootstrapJob(["--mode=live", "--force"]);

    expect(bootstrapMock.runBootstrap).toHaveBeenCalledWith("live", { force: true });
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
