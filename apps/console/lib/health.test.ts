import { describe, expect, it } from "vitest";
import { parseHealth } from "./health";

const wire = {
  state: "healthy",
  stale: false,
  checked_at: "2026-08-23T12:00:00Z",
  reason: null,
  workloads: { total: 8, ready: 8 },
  databases: { total: 1, ready: 1 },
};

describe("parseHealth", () => {
  it("carries the three states through unchanged", () => {
    for (const state of ["healthy", "degraded", "unmeasured"] as const) {
      expect(parseHealth({ ...wire, state }).state).toBe(state);
    }
  });

  it("carries the stale mark", () => {
    expect(parseHealth({ ...wire, stale: true }).stale).toBe(true);
  });

  it("carries a degraded reason", () => {
    const got = parseHealth({ ...wire, state: "degraded", reason: "mp-orders 0/2 ready" });
    expect(got.reason).toBe("mp-orders 0/2 ready");
  });

  it("reads an unrecognised state as unmeasured, never as healthy", () => {
    // A future state this build has not been taught, or a malformed answer.
    // Defaulting to "healthy" would be the parked plane one more time — this
    // time introduced by the parser rather than the sensor.
    expect(parseHealth({ ...wire, state: "sunny" }).state).toBe("unmeasured");
    expect(parseHealth({}).state).toBe("unmeasured");
    expect(parseHealth(null).state).toBe("unmeasured");
  });

  it("reads absent counts as zero rather than throwing", () => {
    // The indicator must render something on every page. A parser that
    // throws takes the whole console layout down with it.
    const got = parseHealth({ state: "healthy" });
    expect(got.workloads).toEqual({ total: 0, ready: 0 });
  });
});
