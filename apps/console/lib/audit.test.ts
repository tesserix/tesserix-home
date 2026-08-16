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
  withSource,
  type AuditEntry,
  type SourcedAuditEntry,
} from "./audit";

function entry(
  over: Partial<SourcedAuditEntry> & Pick<SourcedAuditEntry, "id" | "timestamp">,
): SourcedAuditEntry {
  return {
    actor: "sunita@tesserix.app",
    action: "identity.lookup",
    source: "console",
    ...over,
  };
}

/** One entry as it arrives on the wire, with every required field present. */
function wireEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    source: "mark8ly",
    actor: "sunita@tesserix.app",
    action: "tenant.suspend",
    timestamp: "2026-08-16T09:00:00.000Z",
    ...over,
  };
}

describe("parseEstateAuditLog", () => {
  it("reads entries and failures off the wire", () => {
    const parsed = parseEstateAuditLog({
      product: "all",
      entries: [
        wireEntry({
          id: "mark8ly:9f2",
          target: "tenant:9f2",
          metadata: '{"severity":"critical"}',
        }),
      ],
      failures: [{ source: "kora", message: "kora: responded 502" }],
    });

    expect(parsed.entries).toEqual([
      {
        id: "mark8ly:9f2",
        source: "mark8ly",
        actor: "sunita@tesserix.app",
        action: "tenant.suspend",
        target: "tenant:9f2",
        timestamp: "2026-08-16T09:00:00.000Z",
        metadata: '{"severity":"critical"}',
      },
    ]);
    expect(parsed.failures).toEqual([{ source: "kora", message: "kora: responded 502" }]);
  });

  it("keeps each entry's own source rather than one for the whole body", () => {
    // GUARDS THE GUARD for parsing: a parser that read a single body-level
    // source and stamped it on every row would satisfy "every entry has a
    // source" while telling an operator one product did everything.
    const parsed = parseEstateAuditLog({
      product: "all",
      entries: [
        wireEntry({ id: "mark8ly:9f2", source: "mark8ly" }),
        wireEntry({ id: "kora:42", source: "kora" }),
        wireEntry({ id: "console:41", source: "console" }),
      ],
      failures: [],
    });
    expect(parsed.entries.map((row) => row.source)).toEqual([
      "mark8ly",
      "kora",
      "console",
    ]);
  });

  it("refuses an entry with no source rather than guessing one", () => {
    // An older apps/web merged its three products unattributed. Defaulting the
    // source would put a label on rows whose origin this surface does not know,
    // and a wrong Source column in an audit log is worse than a failed read.
    const { source: _dropped, ...unattributed } = wireEntry();
    expect(() =>
      parseEstateAuditLog({ entries: [unattributed], failures: [] }),
    ).toThrow(/entries\[0\]\.source/);
  });

  it("passes an unknown source through instead of rejecting it", () => {
    // apps/web owns the product list. A fourth product's rows will arrive here
    // before this build knows the id, and `sourceLabel` renders it verbatim —
    // shown honestly under its raw id beats a parse failure or a blank column.
    const parsed = parseEstateAuditLog({
      entries: [wireEntry({ source: "fanzone" })],
      failures: [],
    });
    expect(parsed.entries[0].source).toBe("fanzone");
    expect(sourceLabel(parsed.entries[0].source)).toBe("fanzone");
  });

  it("treats an absent optional as undefined, not as a string", () => {
    // `target` and `metadata` are `?` in the shape the viewer reads. A null
    // arriving as the string "null" would render "null" beside every actor.
    const parsed = parseEstateAuditLog({
      entries: [wireEntry({ target: null, metadata: null })],
      failures: [],
    });
    expect(parsed.entries[0].target).toBeUndefined();
    expect(parsed.entries[0].metadata).toBeUndefined();
  });

  it("throws when a required field is missing rather than coercing it", () => {
    // A renamed field upstream must break loudly. An audit log rendering
    // "undefined did something" is worse than one that says it could not read.
    expect(() =>
      parseEstateAuditLog({
        entries: [{ id: "e1", source: "kora", action: "b", timestamp: "t" }],
        failures: [],
      }),
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

  it("attributes the console's rows and namespaces their ids", () => {
    // `console_audit_log` has no source column and does not need one — every
    // row in it is the same source, derived at read time.
    const consoleRow: AuditEntry = {
      id: "41",
      actor: "sunita@tesserix.app",
      action: "identity.lookup",
      target: "tenant:9f2",
      timestamp: "2026-08-16T09:00:00.000Z",
    };
    const [row] = withSource([consoleRow], "console");
    expect(row.source).toBe("console");
    expect(row.id).toBe("console:41");
    // ...and nothing that carries real audit data is touched. Smuggling the
    // source into `target` would make the row say something the console never
    // recorded.
    expect(row.target).toBe("tenant:9f2");
    expect(row.actor).toBe("sunita@tesserix.app");
    expect(row.action).toBe("identity.lookup");
  });

  it("does not mutate the entries it was given", () => {
    const original: AuditEntry = {
      id: "41",
      actor: "sunita@tesserix.app",
      action: "identity.lookup",
      timestamp: "2026-08-16T09:00:00.000Z",
    };
    withSource([original], "console");
    expect(original.id).toBe("41");
    expect("source" in original).toBe(false);
  });

  it("cannot collide two sources' identical raw ids, because they are namespaced", () => {
    // THE BUG, from the console's side. `console_audit_log.id` is a sequence
    // and kora's and homechef's ids are not guaranteed to be uuids, so a shared
    // `42` is real — and the list is keyed by id, where a collision is a
    // mis-reconciled audit row.
    //
    // Uniqueness is now a property of each row rather than something the merger
    // repairs, so both events survive with their own ids AND their own source.
    const merged = mergeTimeline(
      [entry({ id: "kora:42", source: "kora", timestamp: "2026-08-16T09:00:00.000Z", action: "food.update" })],
      withSource(
        [
          {
            id: "42",
            actor: "sunita@tesserix.app",
            action: "identity.lookup",
            timestamp: "2026-08-16T08:00:00.000Z",
          },
        ],
        "console",
      ),
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.id)).toEqual(["kora:42", "console:42"]);
    expect(merged.map((row) => row.source)).toEqual(["kora", "console"]);
    expect(merged.map((row) => row.action)).toEqual(["food.update", "identity.lookup"]);
  });

  it("keeps both rows when ONE source repeats its own primary key", () => {
    // What `dedupeIds` still guards now that cross-source collisions are
    // impossible: a paginated upstream returning the same row twice. Both rows
    // survive — dropping one to keep React happy would delete an event from an
    // audit timeline, which is the failure this surface exists to prevent.
    const merged = mergeTimeline([
      entry({ id: "kora:42", source: "kora", timestamp: "2026-08-16T09:00:00.000Z" }),
      entry({ id: "kora:42", source: "kora", timestamp: "2026-08-16T08:00:00.000Z" }),
    ]);
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((row) => row.id)).size).toBe(2);
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
