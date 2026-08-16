import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { isDatabaseConfigured, tesserixQuery } from "./tesserix";
import {
  AuditSummaryError,
  AuditUnavailableError,
  AuditWriteError,
  auditedOperation,
  recentAuditEntries,
  serialiseSummary,
  writeAuditEntry,
} from "./audit-repo";

/**
 * A stand-in for console_audit_log that is only as clever as the SQL needs it
 * to be: INSERT appends, SELECT returns newest first. It exists so a write
 * can be asserted to round-trip through the read rather than through a
 * hand-written fixture that agrees with the writer by construction.
 *
 * Rows are stored the way pg returns them — occurred_at as a Date, absent
 * optionals as SQL NULL — so the read's normalisation is exercised for real.
 */
interface StoredRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  occurred_at: Date;
  metadata: string | null;
}

let table: StoredRow[] = [];
let nextId = 0;

function installFakeTable(): void {
  vi.mocked(tesserixQuery).mockImplementation(
    async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO console_audit_log")) {
        const [actor, action, target, occurredAt, metadata] = params as [
          string,
          string,
          string | null,
          string,
          string | null,
        ];
        table = [
          ...table,
          {
            id: `0000000${nextId++}-0000-0000-0000-000000000000`,
            actor,
            action,
            target,
            occurred_at: new Date(occurredAt),
            metadata,
          },
        ];
        return [] as never;
      }
      if (sql.includes("FROM console_audit_log")) {
        const [limit] = params as [number];
        return [...table]
          .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            actor: row.actor,
            action: row.action,
            target: row.target,
            timestamp: row.occurred_at,
            metadata: row.metadata,
          })) as never;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  nextId = 0;
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  installFakeTable();
});

describe("writeAuditEntry / recentAuditEntries", () => {
  it("persists every column and round-trips through the read", async () => {
    await writeAuditEntry({
      actor: "zitadel-sub-9f2c",
      action: "identity.lookup",
      target: "asha@example.com",
      summary: { mark8ly: 2, kora: 0 },
      occurredAt: "2026-08-16T10:00:00.000Z",
    });

    const entries = await recentAuditEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      actor: "zitadel-sub-9f2c",
      action: "identity.lookup",
      target: "asha@example.com",
      timestamp: "2026-08-16T10:00:00.000Z",
      metadata: '{"kora":0,"mark8ly":2}',
    });
  });

  it("keeps an opaque non-uuid actor verbatim", async () => {
    // The `sub` is issued by Zitadel and is not an RFC-4122 uuid; the column
    // is text for that reason, and nothing here may normalise it.
    await writeAuditEntry({
      actor: "XGHvxPEjOyTKbzNAQzd2NZbQzFu1",
      action: "identity.lookup",
    });

    const [entry] = await recentAuditEntries(10);
    expect(entry.actor).toBe("XGHvxPEjOyTKbzNAQzd2NZbQzFu1");
  });

  it("reads absent optionals back as undefined, not null", async () => {
    await writeAuditEntry({ actor: "op-1", action: "identity.lookup" });

    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBeUndefined();
    expect(entry.metadata).toBeUndefined();
    expect("target" in entry).toBe(true);
  });

  it("returns newest first", async () => {
    await writeAuditEntry({
      actor: "op-1",
      action: "identity.lookup",
      target: "older",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
    await writeAuditEntry({
      actor: "op-1",
      action: "identity.lookup",
      target: "newer",
      occurredAt: "2026-08-15T00:00:00.000Z",
    });

    const entries = await recentAuditEntries(10);
    expect(entries.map((e) => e.target)).toEqual(["newer", "older"]);
  });

  it("honours the limit", async () => {
    for (const day of ["01", "02", "03"]) {
      await writeAuditEntry({
        actor: "op-1",
        action: "identity.lookup",
        occurredAt: `2026-08-${day}T00:00:00.000Z`,
      });
    }
    expect(await recentAuditEntries(2)).toHaveLength(2);
  });

  it("wraps a database failure as AuditWriteError rather than swallowing it", async () => {
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("57P01 admin shutdown"));

    await expect(
      writeAuditEntry({ actor: "op-1", action: "identity.lookup" }),
    ).rejects.toBeInstanceOf(AuditWriteError);
  });

  it("refuses a malformed timestamp column rather than coercing it", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        id: "1",
        actor: "op-1",
        action: "identity.lookup",
        target: null,
        timestamp: 1_755_000_000,
        metadata: null,
      },
    ] as never);

    await expect(recentAuditEntries(10)).rejects.toThrow("expected a timestamp");
  });
});

describe("serialiseSummary — metadata cannot smuggle result rows", () => {
  it("rejects a key that is an email address", () => {
    expect(() => serialiseSummary({ "asha@example.com": 1 })).toThrow(
      AuditSummaryError,
    );
  });

  it("rejects a key that is a person's name", () => {
    expect(() => serialiseSummary({ "Asha Pillai": 1 })).toThrow(AuditSummaryError);
  });

  it("rejects a non-numeric value, which is the only place a row could hide", () => {
    // The value type says `number`, so this can only arrive from untyped
    // data — an `any` at a boundary, or JSON parsed from a request. The
    // runtime check is what makes the type guarantee hold there too.
    const smuggled = { mark8ly: "asha@example.com" } as unknown as Record<
      string,
      number
    >;
    expect(() => serialiseSummary(smuggled)).toThrow(AuditSummaryError);
  });

  it("rejects a negative or fractional count", () => {
    expect(() => serialiseSummary({ mark8ly: -1 })).toThrow(AuditSummaryError);
    expect(() => serialiseSummary({ mark8ly: 1.5 })).toThrow(AuditSummaryError);
  });

  it("accepts identifier-shaped source keys with integer counts", () => {
    expect(serialiseSummary({ mark8ly: 2, homechef: 0, "kora.staff": 1 })).toBe(
      '{"homechef":0,"kora.staff":1,"mark8ly":2}',
    );
  });

  it("serialises the same summary identically regardless of key order", () => {
    expect(serialiseSummary({ kora: 1, mark8ly: 2 })).toBe(
      serialiseSummary({ mark8ly: 2, kora: 1 }),
    );
  });
});

describe("auditedOperation", () => {
  it("writes a row and returns the result", async () => {
    const result = await auditedOperation({
      actor: "op-1",
      action: "identity.lookup",
      target: "asha@example.com",
      operation: async () => [{ id: "u1" }, { id: "u2" }],
      summarise: (rows) => ({ mark8ly: rows.length }),
    });

    expect(result).toEqual([{ id: "u1" }, { id: "u2" }]);
    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("asha@example.com");
    expect(entry.metadata).toBe('{"mark8ly":2}');
  });

  it("writes the row when the operation returned nothing", async () => {
    // "Who searched for whom and found nothing" is the interesting case; a
    // zero-result lookup that leaves no trace is the failure this guards.
    const result = await auditedOperation({
      actor: "op-1",
      action: "identity.lookup",
      target: "nobody@example.com",
      operation: async () => [] as { id: string }[],
      summarise: (rows) => ({ mark8ly: rows.length }),
    });

    expect(result).toEqual([]);
    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("nobody@example.com");
    expect(entry.metadata).toBe('{"mark8ly":0}');
  });

  it("propagates a failed audit write instead of returning the results", async () => {
    const operation = vi.fn(async () => [{ id: "u1" }]);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    await expect(
      auditedOperation({
        actor: "op-1",
        action: "identity.lookup",
        target: "asha@example.com",
        operation,
        summarise: (rows) => ({ mark8ly: rows.length }),
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);

    // Guards the guard. "It rejected" passes trivially if the operation never
    // ran and the rejection came from somewhere earlier — from the
    // unconfigured check, say. These assert that the code under test actually
    // reached the write and that the write actually failed, so the rejection
    // is the one being claimed.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tesserixQuery)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tesserixQuery).mock.calls[0][0]).toContain(
      "INSERT INTO console_audit_log",
    );
  });

  it("propagates the operation's own failure unchanged, and writes no row", async () => {
    await expect(
      auditedOperation({
        actor: "op-1",
        action: "identity.lookup",
        operation: async () => {
          throw new Error("upstream 503");
        },
        summarise: () => ({ mark8ly: 0 }),
      }),
    ).rejects.toThrow("upstream 503");

    // No results were produced, so there is nothing that went unaccounted for.
    expect(table).toHaveLength(0);
  });

  it("discards the result when the summariser tries to smuggle rows", async () => {
    const operation = vi.fn(async () => [{ email: "asha@example.com" }]);

    await expect(
      auditedOperation({
        actor: "op-1",
        action: "identity.lookup",
        operation,
        summarise: (rows) =>
          Object.fromEntries(rows.map((r) => [r.email, 1])) as Record<
            string,
            number
          >,
      }),
    ).rejects.toBeInstanceOf(AuditSummaryError);

    // Guards the guard: the operation ran, so the rejection is the
    // summariser's and not an earlier bail-out.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(table).toHaveLength(0);
  });

  it("refuses to run the operation at all when the database is unconfigured", async () => {
    // Not "skip the audit and return the rows": that would turn a missing env
    // var into a silent, permanent bypass of the only control on the lookup.
    // Nothing is read, so nothing needed accounting for.
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const operation = vi.fn(async () => [{ id: "u1" }]);

    await expect(
      auditedOperation({
        actor: "op-1",
        action: "identity.lookup",
        operation,
        summarise: () => ({ mark8ly: 1 }),
      }),
    ).rejects.toBeInstanceOf(AuditUnavailableError);

    expect(operation).not.toHaveBeenCalled();
    expect(vi.mocked(tesserixQuery)).not.toHaveBeenCalled();
  });
});
