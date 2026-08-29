import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));

import { CapabilityError } from "@tesserix/platform-auth";

import { isDatabaseConfigured, tesserixQuery } from "./tesserix";
import {
  AuditActionError,
  AuditSummaryError,
  AuditUnavailableError,
  AuditWriteError,
  auditedOperation,
  isAuditableRefusal,
  recentAuditEntries,
  serialiseSummary,
  writeAuditEntry,
  type AuditableRefusal,
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

// Ruling 16: before `describe` (Ruling 15), `action` was a string literal
// fixed at each call site — statically inspectable, impossible to get wrong
// at runtime. `describe` makes it a runtime return value sitting next to
// `summary`, which already rejects malformed input; `action` must carry the
// same guarantee or the two fields in the same returned object have two
// different trust levels for no reason.
describe("writeAuditEntry — action must be a stable dotted identifier", () => {
  it("accepts a legitimate dotted action", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "crm.stage.change" }),
    ).resolves.toBeUndefined();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });

  // Guards the guard: a validator that accepted everything would pass the
  // test above too.
  it("rejects an empty action", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "" }),
    ).rejects.toBeInstanceOf(AuditActionError);
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("rejects a prose action with spaces", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "changed the stage to qualified" }),
    ).rejects.toBeInstanceOf(AuditActionError);
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("rejects an over-long action", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "crm.".concat("x".repeat(65)) }),
    ).rejects.toBeInstanceOf(AuditActionError);
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("rejects an action that starts with an uppercase letter or a digit", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "Crm.stage.change" }),
    ).rejects.toBeInstanceOf(AuditActionError);
    await expect(
      writeAuditEntry({ actor: "op-1", action: "1crm.stage.change" }),
    ).rejects.toBeInstanceOf(AuditActionError);
  });

  // Rejects rather than sanitises: a malformed action is a bug in the
  // caller's `describe`, and coercing it into something plausible-looking
  // would leave that bug in place while producing a row that reads as fine
  // — precisely what migration 0018's "not free prose" comment forbids.
  it("never reaches the INSERT for a malformed action, even with a valid summary", async () => {
    await expect(
      writeAuditEntry({ actor: "op-1", action: "not an action", summary: { crm: 1 } }),
    ).rejects.toBeInstanceOf(AuditActionError);
    expect(tesserixQuery).not.toHaveBeenCalled();
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
      target: "asha@example.com",
      operation: async () => [{ id: "u1" }, { id: "u2" }],
      describe: (rows) => ({ action: "identity.lookup", summary: { mark8ly: rows.length } }),
    });

    expect(result).toEqual([{ id: "u1" }, { id: "u2" }]);
    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("asha@example.com");
    expect(entry.metadata).toBe('{"mark8ly":2}');
  });

  // The reason `describe` takes the result rather than a fixed `action` at
  // the call site: one call can cover more than one real action, and the
  // audit row must name the one that actually happened.
  it("names the action from the result, not a value fixed before the operation ran", async () => {
    const result = await auditedOperation({
      actor: "op-1",
      target: "org-1",
      operation: async () => ({ stageChanged: false, productChanged: true }),
      describe: (outcome) => ({
        action: outcome.stageChanged ? "crm.stage.change" : "crm.product.set",
        summary: { transitions: outcome.stageChanged ? 1 : 0 },
      }),
    });

    expect(result).toEqual({ stageChanged: false, productChanged: true });
    const [entry] = await recentAuditEntries(10);
    expect(entry.action).toBe("crm.product.set");
    expect(entry.metadata).toBe('{"transitions":0}');
  });

  // Ruling 20: some callers only learn the identifier worth recording from
  // the operation's own result — `removeSuppression` is looked up and
  // deleted by an opaque uuid, but the accountable fact (#204) is the email
  // or Instagram handle the DELETE ... RETURNING reports back. `describe`'s
  // `target` exists for exactly that case, the same way `action` does for a
  // call site that can't know its own action upfront.
  it("lets describe's target override the upfront spec.target", async () => {
    await auditedOperation({
      actor: "op-1",
      target: "5bf22000-uuid-fallback",
      operation: async () => [{ id: "s1", email: "ava@example.com" }],
      describe: (rows) => ({
        action: "crm.suppression.remove",
        summary: { removed: rows.length },
        target: rows[0]?.email,
      }),
    });

    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("ava@example.com");
  });

  // Guards the guard: when describe supplies no target at all (the ordinary
  // case, every other call site in this codebase), the upfront spec.target
  // must still be what gets written — the override is additive, not a
  // replacement for the simple case.
  it("falls back to spec.target when describe supplies none", async () => {
    await auditedOperation({
      actor: "op-1",
      target: "org-1",
      operation: async () => ({ ok: true }),
      describe: () => ({ action: "crm.stage.change", summary: { transitions: 1 } }),
    });

    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("org-1");
  });

  // Fix round 3, minor: an empty string is falsy but not `undefined`/`null`
  // — `target ?? spec.target` would let it win and write an empty target.
  // No caller does this today, but the fallback exists to guarantee a
  // useful value reaches the row, not merely a defined one.
  it("falls back to spec.target when describe supplies an empty string", async () => {
    await auditedOperation({
      actor: "op-1",
      target: "org-1",
      operation: async () => ({ ok: true }),
      describe: () => ({ action: "crm.stage.change", summary: { transitions: 1 }, target: "" }),
    });

    const [entry] = await recentAuditEntries(10);
    expect(entry.target).toBe("org-1");
  });

  it("writes the row when the operation returned nothing", async () => {
    // "Who searched for whom and found nothing" is the interesting case; a
    // zero-result lookup that leaves no trace is the failure this guards.
    const result = await auditedOperation({
      actor: "op-1",
      target: "nobody@example.com",
      operation: async () => [] as { id: string }[],
      describe: (rows) => ({ action: "identity.lookup", summary: { mark8ly: rows.length } }),
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
        target: "asha@example.com",
        operation,
        describe: (rows) => ({ action: "identity.lookup", summary: { mark8ly: rows.length } }),
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
        operation: async () => {
          throw new Error("upstream 503");
        },
        describe: () => ({ action: "identity.lookup", summary: { mark8ly: 0 } }),
      }),
    ).rejects.toThrow("upstream 503");

    // No results were produced, so there is nothing that went unaccounted for.
    expect(table).toHaveLength(0);
  });

  it("discards the result when describe's summary tries to smuggle rows", async () => {
    const operation = vi.fn(async () => [{ email: "asha@example.com" }]);

    await expect(
      auditedOperation({
        actor: "op-1",
        operation,
        describe: (rows) => ({
          action: "identity.lookup",
          summary: Object.fromEntries(rows.map((r) => [r.email, 1])) as Record<string, number>,
        }),
      }),
    ).rejects.toBeInstanceOf(AuditSummaryError);

    // Guards the guard: the operation ran, so the rejection is describe's
    // and not an earlier bail-out.
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
        operation,
        describe: () => ({ action: "identity.lookup", summary: { mark8ly: 1 } }),
      }),
    ).rejects.toBeInstanceOf(AuditUnavailableError);

    expect(operation).not.toHaveBeenCalled();
    expect(vi.mocked(tesserixQuery)).not.toHaveBeenCalled();
  });
});

/**
 * A minimal stand-in for `PublishRefused` (Task 2 implements the real one):
 * an error that opts into being audited by declaring its own description,
 * rather than the call site declaring it. Exercises the interface's shape,
 * not any one caller.
 */
class FakeRefusal extends Error implements AuditableRefusal {
  constructor(
    message: string,
    private readonly description: { action: string; summary: Record<string, number>; target?: string },
  ) {
    super(message);
    this.name = "FakeRefusal";
  }

  auditRefusal(): { action: string; summary: Record<string, number>; target?: string } {
    return this.description;
  }
}

describe("auditedOperation — deliberate refusals (#409)", () => {
  it("recognises a refusal by its auditRefusal method, not by name or instanceof", () => {
    const refusal = new FakeRefusal("nope", {
      action: "catalog.publish.refused",
      summary: { rules_breached: 1 },
    });
    expect(isAuditableRefusal(refusal)).toBe(true);
    expect(isAuditableRefusal(new Error("plain"))).toBe(false);
    expect(isAuditableRefusal(null)).toBe(false);
    expect(isAuditableRefusal("not an error")).toBe(false);
  });

  // The headline case: a refused publish must leave a row, and the caller
  // must still see the refusal — auditing changes what is recorded, never
  // what the caller sees.
  it("writes a row for a deliberate refusal AND rethrows the original error", async () => {
    const refusal = new FakeRefusal("Publishing is refused: price mismatch", {
      action: "catalog.publish.refused",
      summary: { rules_breached: 1 },
      target: "plan-123",
    });

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw refusal;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(refusal);

    const [entry] = await recentAuditEntries(10);
    expect(entry).toBeDefined();
    expect(entry.action).toBe("catalog.publish.refused");
    expect(entry.target).toBe("plan-123");
    expect(entry.metadata).toBe('{"rules_breached":1}');
  });

  // If the row read like the success action, a reviewer scanning the trail
  // would misread a refusal as a completed publish — the highest-stakes
  // action in this system.
  it("gives the refusal row a distinct action from the operation's success action", async () => {
    const refusal = new FakeRefusal("refused", {
      action: "catalog.publish.refused",
      summary: {},
    });

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw refusal;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(refusal);

    const [entry] = await recentAuditEntries(10);
    expect(entry.action).not.toBe("catalog.publish");
    expect(entry.action).toBe("catalog.publish.refused");
  });

  // The other half of the decision: a FAILURE (not a decision — a bug, a
  // dropped connection) must write NOTHING. Recording it would put a
  // database write exactly where the database is the likely cause, and
  // would bury the deliberate refusals — the rows worth reading — in
  // operational noise.
  //
  // Breaks if: refusalDescription() is changed to treat every thrown error
  // as a refusal (e.g. by removing the isAuditableRefusal/CapabilityError
  // gate and calling describe-like logic on any cause).
  it("writes NOTHING for a plain Error (a failure, not a refusal) and rethrows it unchanged", async () => {
    const failure = new Error("connection terminated unexpectedly");

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw failure;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(failure);

    expect(table).toHaveLength(0);
    expect(vi.mocked(tesserixQuery)).not.toHaveBeenCalled();
  });

  // Recognised via a real class import, not `err.name === "CapabilityError"`
  // string matching — CapabilityError lives in @tesserix/platform-auth and
  // cannot implement a console-local interface, so it needs its own adapter
  // branch rather than opting in via AuditableRefusal.
  //
  // Breaks if: the CapabilityError branch in refusalDescription() is removed,
  // or changed to match on `cause.name` instead of `instanceof CapabilityError`.
  it("recognises CapabilityError as a refusal via instanceof, and audits it", async () => {
    const refusal = new CapabilityError("publish-catalog");

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw refusal;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(refusal);

    const [entry] = await recentAuditEntries(10);
    expect(entry).toBeDefined();
    expect(entry.action).toBe("capability.refused");
    expect(entry.action).not.toBe("catalog.publish");
    expect(entry.target).toBe("plan-123");
    // Pins the `required.replaceAll("-", "_")` line: SUMMARY_KEY rejects
    // hyphens, so the hyphenated capability name must be translated, not
    // dropped, to still name what was missing.
    expect(entry.metadata).toBe('{"publish_catalog":1}');
  });

  // The subtle case: if the refusal's OWN audit write fails, the caller must
  // still be told "you were refused", never "audit failed" — an
  // AuditWriteError here would be a strictly worse answer than the truth the
  // operation already knows. The failure is logged server-side (see the
  // implementation) so the gap is not silent, but it must not replace what
  // reaches the caller.
  //
  // Breaks if: the catch around the refusal's own writeAuditEntry call is
  // removed, letting AuditWriteError propagate instead of the refusal.
  it("still rethrows the original refusal, not AuditWriteError, when the audit write for the refusal itself fails", async () => {
    const refusal = new FakeRefusal("refused", {
      action: "catalog.publish.refused",
      summary: { rules_breached: 1 },
    });
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("57P01 admin shutdown"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw refusal;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(refusal);

    // Not AuditWriteError, and not a generic wrapper — the exact refusal.
    expect(table).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Important finding from review: `refusalDescription(cause)` calls
  // `cause.auditRefusal()`, which is caller code this module does not
  // control. If that throws, the throw must not displace the original
  // refusal — the same guarantee requirement 1 makes for a failed
  // audit WRITE must also hold for a failed audit DESCRIBE.
  //
  // Breaks if: `refusalDescription(cause)` (or the call to
  // `cause.auditRefusal()`) is moved back outside `writeRefusal`'s try, so
  // a throwing `auditRefusal()` propagates and replaces `cause`.
  it("still rethrows the original refusal, not whatever auditRefusal() throws, when auditRefusal() itself throws", async () => {
    class ThrowingRefusal extends Error implements AuditableRefusal {
      constructor() {
        super("refused, but describing it is buggy");
        this.name = "ThrowingRefusal";
      }
      auditRefusal(): never {
        throw new Error("bug in auditRefusal()");
      }
    }
    const refusal = new ThrowingRefusal();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw refusal;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(refusal);

    expect(table).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The other half of "a failure writes nothing": an AuditWriteError is the
  // one failure type that can only ever come from this module's own write
  // path, never a caller decision, so it must be treated exactly like any
  // other failure — not mistaken for a refusal because it happens to be an
  // audit-shaped error.
  //
  // Breaks if: `refusalDescription()` starts recognising `AuditWriteError`
  // (e.g. via a broadened `instanceof Error` check) instead of restricting
  // itself to `AuditableRefusal`/`CapabilityError`.
  it("writes nothing and propagates unchanged when the operation itself throws an AuditWriteError", async () => {
    const failure = new AuditWriteError(new Error("57P01 admin shutdown"));

    await expect(
      auditedOperation({
        actor: "op-1",
        target: "plan-123",
        operation: async () => {
          throw failure;
        },
        describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
      }),
    ).rejects.toBe(failure);

    expect(table).toHaveLength(0);
    expect(vi.mocked(tesserixQuery)).not.toHaveBeenCalled();
  });

  // A successful operation is completely unaffected by any of the above:
  // the refusal-detection path is only ever consulted from the catch block.
  it("leaves a successful operation's audit write unchanged", async () => {
    const result = await auditedOperation({
      actor: "op-1",
      target: "plan-123",
      operation: async () => ({ published: true }),
      describe: () => ({ action: "catalog.publish", summary: { published: 1 } }),
    });

    expect(result).toEqual({ published: true });
    const [entry] = await recentAuditEntries(10);
    expect(entry.action).toBe("catalog.publish");
  });
});
