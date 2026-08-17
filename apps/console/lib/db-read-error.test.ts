import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_IMPLEMENTED, resolveState } from "@/components/kit/surface-state";
import {
  MIGRATIONS_PENDING_TITLE,
  dbReadError,
  isUndefinedTable,
  migrationsPendingMessage,
  readFailedMessage,
} from "./db-read-error";

const SURFACE = "the Due queue";

/** Postgres raising `undefined_table`, as `pg` surfaces it: the SQLSTATE on
 *  `.code`, the relation name in `.message`. */
function undefinedTable(relation = "crm_opportunities"): Error & { code: string } {
  return Object.assign(new Error(`relation "${relation}" does not exist`), { code: "42P01" });
}

function stateFor(caught: unknown) {
  return resolveState({
    isLoading: false,
    error: dbReadError(caught, SURFACE),
    rows: [],
    filtered: false,
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dbReadError", () => {
  it("returns null when nothing was caught", () => {
    expect(dbReadError(null, SURFACE)).toBeNull();
    expect(dbReadError(undefined, SURFACE)).toBeNull();
  });

  it("never passes the driver's message through", () => {
    // The reason this helper exists: `pg`'s message names relations,
    // constraints, roles and hosts, all written for a server log.
    const surfaced = dbReadError(new Error("password authentication failed for user \"crm\""), SURFACE);
    expect(surfaced?.message).toBe(readFailedMessage(SURFACE));
    expect(surfaced?.message).not.toContain("crm");
  });

  it("keeps the real error for the server log", () => {
    const caught = new Error("ECONNREFUSED 10.0.0.4:5432");
    dbReadError(caught, SURFACE);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(SURFACE), caught);
  });

  it("preserves a 501 so a parked surface does not read as broken", () => {
    expect(dbReadError({ status: NOT_IMPLEMENTED, message: "parked" }, SURFACE)).toEqual({
      status: NOT_IMPLEMENTED,
    });
  });

  it("resolves a missing table to instrumentation-unavailable", () => {
    // An un-migrated database is "not set up yet", not "something went wrong":
    // nothing failed and nothing is flaky, so telling an operator to retry
    // would be advice that can never work.
    expect(stateFor(undefinedTable())).toEqual({
      kind: "instrumentation-unavailable",
      title: MIGRATIONS_PENDING_TITLE,
      message: migrationsPendingMessage(SURFACE),
    });
  });

  it("names the remedy rather than telling the operator to wait", () => {
    const copy = migrationsPendingMessage(SURFACE);
    expect(copy).toContain("migrations");
    expect(copy).not.toContain("Try again");
  });

  it("still resolves a different Postgres error to error", () => {
    // Guards the guard: a blanket mapping would satisfy the test above while
    // describing a dead database, a permissions problem or a syntax error as
    // an un-migrated one.
    for (const code of ["42501", "28P01", "08006", "22P02"]) {
      expect(stateFor(Object.assign(new Error("boom"), { code }))).toEqual({
        kind: "error",
        message: readFailedMessage(SURFACE),
      });
    }
  });

  it("reads the SQLSTATE, not the message text", () => {
    // A message can say "does not exist" in any language, and a hostile or
    // merely unlucky string must not be able to claim the calm state.
    expect(stateFor(new Error('relation "crm_opportunities" does not exist'))).toEqual({
      kind: "error",
      message: readFailedMessage(SURFACE),
    });
  });
});

describe("isUndefinedTable", () => {
  it("sees through a repository that wrapped the driver error", () => {
    const wrapped = new Error("reading the due queue failed", { cause: undefinedTable() });
    expect(isUndefinedTable(wrapped)).toBe(true);
  });

  it("says no to everything else", () => {
    expect(isUndefinedTable(null)).toBe(false);
    expect(isUndefinedTable("42P01")).toBe(false);
    expect(isUndefinedTable(new Error("nope"))).toBe(false);
  });
});
