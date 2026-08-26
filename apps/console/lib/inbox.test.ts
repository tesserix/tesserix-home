import { describe, expect, it } from "vitest";

import { parseInbox } from "./inbox";

/** The shape platform-api's inbox module emits, as its Go tests pin it. */
const body = {
  items: [
    {
      id: "kora:u9",
      source: "kora",
      kind: "unresolved_food",
      title: "ragi mudde",
      subtitle: "no match — the index has no candidate",
      waiting_since: "2026-08-18T09:00:00Z",
      severity: "warning",
      actions: [{ id: "resolve", label: "Resolve", destructive: false }],
    },
    {
      id: "kora:f1",
      source: "kora",
      kind: "feedback",
      title: "App crashed",
      waiting_since: "2026-08-20T09:00:00Z",
      actions: [],
    },
  ],
  total: 7,
  failures: [],
};

describe("parseInbox", () => {
  it("reads the platform API's shape", () => {
    const page = parseInbox(body);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.kind).toBe("unresolved_food");
    expect(page.items[0]?.actions[0]?.label).toBe("Resolve");
    // The product's own queue depth, which may exceed the rows returned.
    expect(page.total).toBe(7);
  });

  it("keeps waiting_since as the string the API sent", () => {
    // Parsing to a Date here would throw away the offset the product chose,
    // and §4.3 requires that offset to be present and meaningful.
    expect(parseInbox(body).items[1]?.waitingSince).toBe("2026-08-20T09:00:00Z");
  });

  // A console-side enumeration of kinds would be a second vocabulary that
  // drifts from the product's. An unknown kind must survive parsing.
  it("accepts a kind this build has never seen", () => {
    const page = parseInbox({
      ...body,
      items: [{ ...body.items[1], kind: "some_future_kind" }],
    });
    expect(page.items[0]?.kind).toBe("some_future_kind");
  });

  // Absent and "due now" must not collapse into each other.
  it("distinguishes an absent due_at from a present one", () => {
    expect(parseInbox(body).items[0]?.dueAt).toBeUndefined();
    const withDue = parseInbox({
      ...body,
      items: [{ ...body.items[1], due_at: "2026-08-27T09:00:00Z" }],
    });
    expect(withDue.items[0]?.dueAt).toBe("2026-08-27T09:00:00Z");
  });

  it("treats an omitted destructive flag as not destructive", () => {
    const page = parseInbox({
      ...body,
      items: [{ ...body.items[1], actions: [{ id: "a", label: "A" }] }],
    });
    expect(page.items[0]?.actions[0]?.destructive).toBe(false);
  });

  // THE property this parser exists for. A body without `failures` cannot be
  // proven complete, and defaulting it would let "one product was unreachable"
  // render identically to "nothing is waiting" — on a queue, the difference
  // between reassurance and a false one.
  it("refuses a body with no failures rather than defaulting it", () => {
    expect(() => parseInbox({ items: [], total: 0 })).toThrow(/failures/);
  });

  it("refuses a body with no total", () => {
    // Absent, an empty page and a page bounded below a real backlog look the
    // same.
    expect(() => parseInbox({ items: [], failures: [] })).toThrow(/total/);
    expect(() => parseInbox({ items: [], failures: [], total: -1 })).toThrow(/total/);
    expect(() => parseInbox({ items: [], failures: [], total: 1.5 })).toThrow(/total/);
  });

  it("refuses an item with no source", () => {
    // A wrong Source column is worse than a failed read.
    const { source: _dropped, ...noSource } = body.items[1] as Record<string, unknown>;
    expect(() => parseInbox({ ...body, items: [noSource] })).toThrow(/source/);
  });

  it("refuses an item whose actions are not an array", () => {
    expect(() => parseInbox({ ...body, items: [{ ...body.items[1], actions: null }] })).toThrow(
      /actions/,
    );
  });

  it("names the offending path so the fix does not require a search", () => {
    expect(() => parseInbox({ ...body, items: [{ ...body.items[1], title: 42 }] })).toThrow(
      /items\[0\]\.title/,
    );
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseInbox(null)).toThrow();
    expect(() => parseInbox([])).toThrow();
  });

  it("reads failures, which is what makes a partial estate renderable", () => {
    const page = parseInbox({
      ...body,
      failures: [{ source: "other", message: "connection failed" }],
    });
    expect(page.failures).toHaveLength(1);
    expect(page.failures[0]?.source).toBe("other");
  });
});
