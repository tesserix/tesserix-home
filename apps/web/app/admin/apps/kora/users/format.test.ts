import { describe, expect, it } from "vitest";
import { everLogged, formatDate, isEmpty } from "./format";

describe("formatDate", () => {
  // Every date-bearing column (Signed up, Onboarded, First log, Last write)
  // routes through this. Kora's own fields are nullable (`onboarded_at`,
  // `first_log`, `last_write` are all `string | null`), so the null guard is
  // exercised on nearly every row for a beta-sized user base.
  it("renders '—' for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  // Guards against `new Date("not-a-date").toLocaleDateString()` rendering
  // the literal string "Invalid Date" in a table read for activation signal.
  it("renders '—' for an unparseable string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("renders a valid ISO string as a human date", () => {
    expect(formatDate("2026-08-07T12:00:00Z")).toBe("Aug 7, 2026");
  });
});

describe("everLogged", () => {
  // The exact boundary the column is named for: 0 reads as "never", any
  // positive count reads as "yes". Both sides of the `> 0` boundary are
  // asserted so a `>=` or `===` typo would fail one of these.
  it("is false at log_count 0", () => {
    expect(everLogged(0)).toBe(false);
  });

  it("is true for any positive log_count", () => {
    expect(everLogged(1)).toBe(true);
    expect(everLogged(42)).toBe(true);
  });
});

describe("isEmpty", () => {
  it("is true for an empty array", () => {
    expect(isEmpty([])).toBe(true);
  });

  it("is false once there is at least one item", () => {
    expect(isEmpty([{ id: "1" }])).toBe(false);
  });
});
