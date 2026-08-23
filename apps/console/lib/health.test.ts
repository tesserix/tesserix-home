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
    expect(parseHealth({ state: "degraded" }).workloads).toEqual({
      total: 0,
      ready: 0,
      items: null,
    });
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
    expect(short.workloads).toEqual({ total: 8, ready: 3, items: null });
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

  describe("per-item detail", () => {
    it("parses workload items", () => {
      const got = parseHealth({
        ...wire,
        workloads: {
          total: 8,
          ready: 8,
          items: [{ name: "console", desired: 2, ready: 2 }],
        },
      });

      expect(got.workloads.items).toEqual([{ name: "console", desired: 2, ready: 2, ok: true }]);
    });

    it("parses database items, including a null phase", () => {
      const got = parseHealth({
        ...wire,
        databases: {
          total: 1,
          ready: 1,
          items: [
            {
              name: "tesserix-postgres",
              instances: 1,
              ready: 1,
              phase: "Cluster in healthy state",
            },
          ],
        },
      });

      expect(got.databases.items).toEqual([
        {
          name: "tesserix-postgres",
          instances: 1,
          ready: 1,
          phase: "Cluster in healthy state",
          ok: true,
        },
      ]);
    });

    it("reports no items when the payload carries none — the older API shape", () => {
      // An older platform-api answers without `items` at all. This must be
      // distinguishable from a genuinely empty list so the page can render
      // exactly as it does today rather than showing an empty table.
      const got = parseHealth(wire);

      expect(got.workloads.items).toBeNull();
      expect(got.databases.items).toBeNull();
    });

    it("does not throw when items is missing, null, or the wrong shape entirely", () => {
      expect(() => parseHealth({ ...wire, workloads: { total: 8, ready: 8, items: null } }))
        .not.toThrow();
      expect(parseHealth({ ...wire, workloads: { total: 8, ready: 8, items: null } }).workloads.items)
        .toBeNull();

      expect(() => parseHealth({ ...wire, workloads: { total: 8, ready: 8, items: "nope" } }))
        .not.toThrow();
      expect(
        parseHealth({ ...wire, workloads: { total: 8, ready: 8, items: "nope" } }).workloads.items,
      ).toBeNull();
    });

    it("drops a malformed item instead of throwing or trusting it", () => {
      const got = parseHealth({
        ...wire,
        workloads: {
          total: 8,
          ready: 8,
          items: [
            { name: "console", desired: 2, ready: 2 },
            "not an object",
            { desired: 1, ready: 1 }, // missing name — unusable, drop it
            null,
            42,
          ],
        },
      });

      expect(got.workloads.items).toEqual([{ name: "console", desired: 2, ready: 2, ok: true }]);
    });

    it("coerces a non-numeric count to 0, matching counts()'s own style", () => {
      const got = parseHealth({
        ...wire,
        workloads: {
          total: 8,
          ready: 8,
          items: [{ name: "console", desired: "two", ready: null }],
        },
      });

      expect(got.workloads.items).toEqual([{ name: "console", desired: 0, ready: 0, ok: true }]);
    });

    it("coerces a non-string phase to null rather than trusting it", () => {
      const got = parseHealth({
        ...wire,
        databases: {
          total: 1,
          ready: 1,
          items: [{ name: "tesserix-postgres", instances: 1, ready: 1, phase: 42 }],
        },
      });

      expect(got.databases.items).toEqual([
        { name: "tesserix-postgres", instances: 1, ready: 1, phase: null, ok: true },
      ]);
    });

    it("carries items through the degraded-downgrade path", () => {
      // The "healthy but short" downgrade must not silently drop the detail
      // rows it was carrying — the page still shows what was read.
      const got = parseHealth({
        ...wire,
        state: "healthy",
        workloads: {
          total: 8,
          ready: 3,
          items: [{ name: "console", desired: 2, ready: 0 }],
        },
      });

      expect(got.state).toBe("degraded");
      expect(got.workloads.items).toEqual([{ name: "console", desired: 2, ready: 0, ok: false }]);
    });

    it("carries the classifier's own per-row verdict rather than re-deriving it", () => {
      // A cluster mid-failover reports MATCHING counts and is not healthy.
      // Nothing on the client can know that from the numbers, which is why
      // the verdict is on the wire.
      const got = parseHealth({
        ...wire,
        state: "degraded",
        databases: {
          total: 1,
          ready: 0,
          items: [
            {
              name: "tesserix-postgres",
              instances: 1,
              ready: 1,
              phase: "Failing over",
              ok: false,
            },
          ],
        },
      });

      expect(got.databases.items?.[0].ok).toBe(false);
    });

    it("falls back to the counts comparison when ok is absent — the older API shape", () => {
      // An older platform-api sends items with no `ok` at all, and one is
      // live in production until this ships. The fallback is EXACTLY what
      // the row did before this field existed: imperfect (it cannot see a
      // phase), but the old behaviour rather than a guess.
      const got = parseHealth({
        ...wire,
        state: "degraded",
        workloads: {
          total: 2,
          ready: 1,
          items: [
            { name: "short", desired: 2, ready: 1 },
            { name: "fine", desired: 2, ready: 2 },
          ],
        },
        databases: {
          total: 1,
          ready: 1,
          items: [
            { name: "pg", instances: 1, ready: 1, phase: "Failing over" },
          ],
        },
      });

      expect(got.workloads.items?.map((item) => item.ok)).toEqual([false, true]);
      // Matching counts and no `ok`: the old row said "fine" and so does
      // this. The phase is invisible to the fallback, which is the point.
      expect(got.databases.items?.[0].ok).toBe(true);
    });

    it("ignores a non-boolean ok rather than trusting it", () => {
      const got = parseHealth({
        ...wire,
        workloads: {
          total: 1,
          ready: 0,
          items: [{ name: "console", desired: 2, ready: 0, ok: "yes" }],
        },
      });

      expect(got.workloads.items?.[0].ok).toBe(false);
    });
  });
});
