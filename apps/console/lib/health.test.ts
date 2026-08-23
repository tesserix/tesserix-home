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

  it("does not throw on absent counts", () => {
    expect(() => parseHealth({ state: "degraded" })).not.toThrow();
    expect(parseHealth({ state: "degraded" }).workloads).toEqual({ total: 0, ready: 0 });
  });

  it("refuses a healthy claim that counted nothing", () => {
    // The parked plane, one layer out. A payload can say "healthy" and carry
    // no counts — a version skew, a partial response — and rendering that
    // green is the failure this whole feature exists to prevent.
    expect(parseHealth({ state: "healthy" }).state).toBe("unmeasured");
    expect(parseHealth({ state: "healthy", workloads: { total: 3, ready: 3 } }).state)
      .toBe("unmeasured");
    expect(
      parseHealth({
        state: "healthy",
        workloads: { total: 3, ready: 3 },
        databases: { total: 1, ready: 1 },
      }).state,
    ).toBe("healthy");
  });

  it("refuses a healthy claim whose own counts are short", () => {
    // Guarding the state STRING is not the same as guarding the CLAIM. A
    // payload saying "healthy" while reporting 3 of 8 workloads ready renders
    // a green dot, the word "Healthy", and "Workloads 3 / 8" directly beneath
    // it — the state word contradicted by the numbers next to it.
    const short = parseHealth({
      ...wire,
      state: "healthy",
      workloads: { total: 8, ready: 3 },
      databases: { total: 1, ready: 1 },
    });

    // `degraded`, not `unmeasured`: something WAS measured and it came back
    // short. Discarding a real reading would be its own dishonesty.
    expect(short.state).toBe("degraded");
    expect(short.reason).toMatch(/claimed healthy but reported fewer ready than total/);
    // The counts survive the downgrade — the page still shows what was read.
    expect(short.workloads).toEqual({ total: 8, ready: 3 });
  });

  it("catches short counts on the database side too", () => {
    expect(
      parseHealth({
        ...wire,
        state: "healthy",
        workloads: { total: 8, ready: 8 },
        databases: { total: 2, ready: 1 },
      }).state,
    ).toBe("degraded");
  });

  it("still calls a genuinely complete healthy reading healthy", () => {
    // Guards the guard: a downgrade rule that fires on everything would
    // satisfy the two tests above while deleting the healthy state.
    expect(parseHealth(wire).state).toBe("healthy");
  });
});
