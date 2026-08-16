import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api";
import {
  AUDIT_SOURCES,
  CONSOLE_SOURCE,
  byNewestFirst,
  dedupeIds,
  includesConsoleSource,
  isAuditSource,
  mergeTimeline,
  parseEstateAuditLog,
  sourceLabel,
  upstreamProductFor,
  withSourcePrefix,
  type AuditEntry,
} from "./audit";

function entry(over: Partial<AuditEntry> & Pick<AuditEntry, "id" | "timestamp">): AuditEntry {
  return {
    actor: "sunita@tesserix.app",
    action: "identity.lookup",
    ...over,
  };
}

describe("parseEstateAuditLog", () => {
  it("reads entries and failures off the wire", () => {
    const parsed = parseEstateAuditLog({
      product: "all",
      entries: [
        {
          id: "e1",
          actor: "sunita@tesserix.app",
          action: "tenant.suspend",
          target: "tenant:9f2",
          timestamp: "2026-08-16T09:00:00.000Z",
          metadata: '{"severity":"critical"}',
        },
      ],
      failures: [{ source: "kora", message: "kora: responded 502" }],
    });

    expect(parsed.entries).toEqual([
      {
        id: "e1",
        actor: "sunita@tesserix.app",
        action: "tenant.suspend",
        target: "tenant:9f2",
        timestamp: "2026-08-16T09:00:00.000Z",
        metadata: '{"severity":"critical"}',
      },
    ]);
    expect(parsed.failures).toEqual([{ source: "kora", message: "kora: responded 502" }]);
  });

  it("treats an absent optional as undefined, not as a string", () => {
    // `target` and `metadata` are `?` in the shape the viewer reads. A null
    // arriving as the string "null" would render "null" beside every actor.
    const parsed = parseEstateAuditLog({
      entries: [
        {
          id: "e1",
          actor: "a",
          action: "b",
          target: null,
          timestamp: "2026-08-16T09:00:00.000Z",
          metadata: null,
        },
      ],
      failures: [],
    });
    expect(parsed.entries[0].target).toBeUndefined();
    expect(parsed.entries[0].metadata).toBeUndefined();
  });

  it("throws when a required field is missing rather than coercing it", () => {
    // A renamed field upstream must break loudly. An audit log rendering
    // "undefined did something" is worse than one that says it could not read.
    expect(() =>
      parseEstateAuditLog({ entries: [{ id: "e1", action: "b", timestamp: "t" }], failures: [] }),
    ).toThrow(PlatformApiError);
  });

  it("refuses a body with no failures array at all", () => {
    // NOT defaulted to []. Absent `failures` means an older apps/web or a
    // different endpoint, and reading the absence as "nothing failed" would
    // assert completeness this surface cannot verify — the one claim it must
    // never make by accident.
    expect(() => parseEstateAuditLog({ entries: [] })).toThrow(/failures is missing/);
  });

  it("rejects a non-object response", () => {
    expect(() => parseEstateAuditLog("<html>502 Bad Gateway</html>")).toThrow(
      PlatformApiError,
    );
  });
});

describe("sources", () => {
  it("names Fe3dr by its product name, not by its context key", () => {
    // ESTATE records the two separately on purpose: the context is "homechef",
    // and nobody calls the product that.
    expect(sourceLabel("homechef")).toBe("Fe3dr");
    expect(sourceLabel("mark8ly")).toBe("Mark8ly");
    expect(sourceLabel(CONSOLE_SOURCE)).toBe("Console");
  });

  it("returns an unknown source id verbatim", () => {
    // The aggregate's `failures` can name a source this build has never heard
    // of. Inventing a label would hide exactly the case worth seeing.
    expect(sourceLabel("fanzone")).toBe("fanzone");
  });

  it("only accepts sources that exist", () => {
    expect(isAuditSource("kora")).toBe(true);
    expect(isAuditSource("devai")).toBe(false);
    expect(AUDIT_SOURCES).toContain(CONSOLE_SOURCE);
  });

  it("never sends the console's own source id upstream", () => {
    // `/api/admin/apps/console/audit-logs` is a 404 by design. Calling it
    // would also render "Kora unavailable" on a view not showing Kora.
    expect(upstreamProductFor(CONSOLE_SOURCE)).toBeNull();
    expect(includesConsoleSource(CONSOLE_SOURCE)).toBe(true);
  });

  it("asks for every product at once when nothing is filtered", () => {
    // One request, not three: the fan-out and the partial-failure semantics
    // both live behind the endpoint.
    expect(upstreamProductFor(null)).toBe("all");
    expect(includesConsoleSource(null)).toBe(true);
  });

  it("drops the console's rows when a single product is selected", () => {
    expect(upstreamProductFor("kora")).toBe("kora");
    expect(includesConsoleSource("kora")).toBe(false);
  });
});

describe("merging the timeline", () => {
  it("interleaves both sources newest-first", () => {
    // The interleaving IS the surface. "The console granted access at 09:02 and
    // mark8ly recorded the export at 09:03" is a story a source-grouped list
    // does not tell.
    const merged = mergeTimeline(
      [entry({ id: "p1", timestamp: "2026-08-16T09:03:00.000Z" })],
      [entry({ id: "c1", timestamp: "2026-08-16T09:02:00.000Z" })],
      [entry({ id: "p2", timestamp: "2026-08-16T09:04:00.000Z" })],
    );
    expect(merged.map((row) => row.id)).toEqual(["p2", "p1", "c1"]);
  });

  it("orders equal timestamps deterministically", () => {
    const a = entry({ id: "a", timestamp: "2026-08-16T09:00:00.000Z" });
    const b = entry({ id: "b", timestamp: "2026-08-16T09:00:00.000Z" });
    expect(byNewestFirst(a, b)).toBeGreaterThan(0);
    expect(byNewestFirst(b, a)).toBeLessThan(0);
    expect(byNewestFirst(a, a)).toBe(0);
  });

  it("namespaces ids per source without touching the rest of the row", () => {
    const [row] = withSourcePrefix(
      [entry({ id: "12", timestamp: "2026-08-16T09:00:00.000Z", target: "tenant:9f2" })],
      "console",
    );
    expect(row.id).toBe("console:12");
    expect(row.target).toBe("tenant:9f2");
  });

  it("does not mutate the entries it was given", () => {
    const original = entry({ id: "12", timestamp: "2026-08-16T09:00:00.000Z" });
    withSourcePrefix([original], "console");
    expect(original.id).toBe("12");
  });

  it("keeps both rows when two sources share an id", () => {
    // `console_audit_log.id` is a sequence and the products' ids are not
    // guaranteed to be uuids, so a collision is real. The viewer keys its list
    // by id, and two rows sharing a key is a mis-reconciled audit entry.
    //
    // Both rows survive. Dropping one to keep React happy would delete an
    // event from an audit timeline, which is the failure this surface exists
    // to make impossible.
    const merged = mergeTimeline(
      [entry({ id: "12", timestamp: "2026-08-16T09:00:00.000Z", action: "product.thing" })],
      [entry({ id: "12", timestamp: "2026-08-16T08:00:00.000Z", action: "console.thing" })],
    );
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((row) => row.id)).size).toBe(2);
    expect(merged.map((row) => row.action)).toEqual(["product.thing", "console.thing"]);
  });

  it("leaves the first occurrence's id untouched", () => {
    // Only the duplicate is disambiguated, so the id an operator would
    // recognise stays as it is.
    const deduped = dedupeIds([
      entry({ id: "12", timestamp: "2026-08-16T09:00:00.000Z" }),
      entry({ id: "12", timestamp: "2026-08-16T08:00:00.000Z" }),
      entry({ id: "12", timestamp: "2026-08-16T07:00:00.000Z" }),
    ]);
    expect(deduped.map((row) => row.id)).toEqual(["12", "12#2", "12#3"]);
  });

  it("does not collide with an id that already carries the suffix", () => {
    const deduped = dedupeIds([
      entry({ id: "12", timestamp: "2026-08-16T09:00:00.000Z" }),
      entry({ id: "12#2", timestamp: "2026-08-16T08:30:00.000Z" }),
      entry({ id: "12", timestamp: "2026-08-16T08:00:00.000Z" }),
    ]);
    expect(new Set(deduped.map((row) => row.id)).size).toBe(3);
  });
});
