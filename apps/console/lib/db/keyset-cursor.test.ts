import { describe, expect, it } from "vitest";
import {
  MalformedCursorError,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isMalformedCursorError,
  trimBackwardPage,
  trimForwardPage,
} from "./keyset-cursor";

const TIMESTAMP = "2026-07-20T00:00:00.000Z";
const ID = "11111111-1111-1111-1111-111111111111";

const forge = (payload: string) => Buffer.from(payload, "utf-8").toString("base64");

describe("the keyset cursor codec", () => {
  it("round trips the tuple and the direction it points in", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(TIMESTAMP, ID, "after"), "test")).toEqual({
      timestamp: TIMESTAMP,
      id: ID,
      direction: "after",
    });
    expect(decodeKeysetCursor(encodeKeysetCursor(TIMESTAMP, ID, "before"), "test")).toEqual({
      timestamp: TIMESTAMP,
      id: ID,
      direction: "before",
    });
  });

  it("encodes the two directions differently over the same tuple", () => {
    // The whole point of carrying direction IN the cursor: a shared or
    // reloaded link must page the way it was built to page. If both
    // directions encoded to the same string, `?cursor=` would be ambiguous
    // and the surface would silently render the wrong page.
    expect(encodeKeysetCursor(TIMESTAMP, ID, "after")).not.toBe(
      encodeKeysetCursor(TIMESTAMP, ID, "before"),
    );
  });

  it("rejects a cursor that names no direction", () => {
    // The pre-#241 two-part shape. Rejected rather than assumed to be
    // "after": assuming would make a stale link render a page nobody asked
    // for, which is the failure the direction exists to prevent.
    expect(() => decodeKeysetCursor(forge(`${TIMESTAMP}|${ID}`), "test")).toThrow(
      MalformedCursorError,
    );
  });

  it("rejects a direction that is not one of the two", () => {
    expect(() => decodeKeysetCursor(forge(`sideways|${TIMESTAMP}|${ID}`), "test")).toThrow(
      MalformedCursorError,
    );
    expect(() => decodeKeysetCursor(forge(`|${TIMESTAMP}|${ID}`), "test")).toThrow(
      MalformedCursorError,
    );
  });

  it("rejects a non-uuid id, an unparseable timestamp, and extra fields", () => {
    expect(() => decodeKeysetCursor(forge(`after|${TIMESTAMP}|1 OR 1=1`), "test")).toThrow(
      MalformedCursorError,
    );
    expect(() => decodeKeysetCursor(forge(`after|not-a-date|${ID}`), "test")).toThrow(
      MalformedCursorError,
    );
    expect(() => decodeKeysetCursor(forge(`after|${TIMESTAMP}|${ID}|extra`), "test")).toThrow(
      MalformedCursorError,
    );
    expect(() => decodeKeysetCursor("not-a-cursor", "test")).toThrow(MalformedCursorError);
  });

  it("names the rejecting caller in the message", () => {
    expect(() => decodeKeysetCursor("not-a-cursor", "dueOpportunities")).toThrow(
      /dueOpportunities/,
    );
  });
});

describe("isMalformedCursorError", () => {
  it("recognises the error the codec throws", () => {
    expect(isMalformedCursorError(new MalformedCursorError("test"))).toBe(true);
  });

  it("sees through a repository that wrapped it", () => {
    const wrapped = new Error("reading the due queue failed", {
      cause: new MalformedCursorError("dueOpportunities"),
    });
    expect(isMalformedCursorError(wrapped)).toBe(true);
  });

  it("says no to everything else", () => {
    expect(isMalformedCursorError(null)).toBe(false);
    expect(isMalformedCursorError("malformed cursor")).toBe(false);
    expect(isMalformedCursorError(new Error("malformed cursor"))).toBe(false);
  });
});

describe("trimForwardPage", () => {
  it("drops the proof row and keeps the fetched order", () => {
    const { rows, hasMore } = trimForwardPage(["a", "b", "c"], 2);
    expect(rows).toEqual(["a", "b"]);
    expect(hasMore).toBe(true);
  });

  it("reports no further page when the fetch came back short", () => {
    const { rows, hasMore } = trimForwardPage(["a", "b"], 2);
    expect(rows).toEqual(["a", "b"]);
    expect(hasMore).toBe(false);
  });

  it("does not mutate the rows it was given", () => {
    const fetched = ["a", "b", "c"];
    trimForwardPage(fetched, 2);
    expect(fetched).toEqual(["a", "b", "c"]);
  });
});

describe("trimBackwardPage", () => {
  it("restores display order, because a backward fetch arrives reversed", () => {
    // The subtle one. A backward page is fetched with the ORDER BY flipped,
    // so SQL hands back the row NEAREST the anchor first — the last row of
    // the page, not the first. Returning that as-is renders the page upside
    // down while every count and cursor still looks right, which is why this
    // asserts the sequence and not the set.
    const { rows, hasMore } = trimBackwardPage(["d", "c", "b", "a"], 3);
    expect(rows).toEqual(["b", "c", "d"]);
    expect(hasMore).toBe(true);
  });

  it("drops the proof row from the far end, not from the page", () => {
    // Fetched backwards, the extra row is the one FURTHEST from the anchor —
    // it belongs to the page before this one. Trimming the near end instead
    // would drop a row the operator is entitled to and skip it forever.
    const { rows } = trimBackwardPage(["d", "c", "b", "a"], 3);
    expect(rows).not.toContain("a");
  });

  it("reports no earlier page when the fetch came back short", () => {
    const { rows, hasMore } = trimBackwardPage(["c", "b", "a"], 3);
    expect(rows).toEqual(["a", "b", "c"]);
    expect(hasMore).toBe(false);
  });

  it("does not mutate the rows it was given", () => {
    // `Array.prototype.reverse` reverses in place; the caller's array is the
    // driver's result set, and quietly rewriting it is exactly the kind of
    // action at a distance the house rule against mutation exists for.
    const fetched = ["c", "b", "a"];
    trimBackwardPage(fetched, 3);
    expect(fetched).toEqual(["c", "b", "a"]);
  });
});
