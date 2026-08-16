import { describe, expect, it } from "vitest";
import {
  countUnread,
  mergeEvents,
  toReplyEvent,
  toTicketEvent,
  type NotificationItem,
} from "./notifications";

const TICKET_ROW = {
  id: "5f0b2c34-0000-0000-0000-000000000000",
  product_id: "mark8ly",
  ticket_number: "M8-1042",
  subject: "Payout missing",
  submitted_by_name: "Asha Pillai",
  created_at: "2026-08-14T04:00:00.000Z",
};

const REPLY_ROW = {
  id: "77770000-0000-0000-0000-000000000000",
  ticket_id: "5f0b2c34-0000-0000-0000-000000000000",
  author_name: "Asha Pillai",
  created_at: "2026-08-15T04:00:00.000Z",
  ticket_number: "M8-1042",
  product_id: "mark8ly",
  subject: "Payout missing",
};

function item(at: string, id = at): NotificationItem {
  return {
    id,
    kind: "ticket_created",
    ticketId: "t",
    ticketNumber: "M8-1",
    productId: "mark8ly",
    subject: "s",
    actor: "a",
    at,
  };
}

describe("toTicketEvent", () => {
  it("links to the ticket by uuid, not by number", () => {
    // The detail route keys on the uuid; the number is for humans only.
    const e = toTicketEvent(TICKET_ROW);
    expect(e.ticketId).toBe(TICKET_ROW.id);
    expect(e.ticketNumber).toBe("M8-1042");
    expect(e.kind).toBe("ticket_created");
    expect(e.actor).toBe("Asha Pillai");
    expect(e.at).toBe(TICKET_ROW.created_at);
  });

  it("gives the event an id distinct from the reply with the same row id", () => {
    // Both feeds are merged into one list; a bare row id could collide.
    const t = toTicketEvent(TICKET_ROW);
    const r = toReplyEvent({ ...REPLY_ROW, id: TICKET_ROW.id });
    expect(t.id).not.toBe(r.id);
  });
});

describe("toReplyEvent", () => {
  it("points at the parent ticket, not the reply", () => {
    const e = toReplyEvent(REPLY_ROW);
    expect(e.ticketId).toBe(REPLY_ROW.ticket_id);
    expect(e.kind).toBe("merchant_reply");
    expect(e.actor).toBe("Asha Pillai");
  });
});

describe("mergeEvents", () => {
  it("interleaves both sources newest first", () => {
    const merged = mergeEvents(
      [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
      [item("2026-08-12T00:00:00.000Z")],
      10,
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ]);
  });

  it("truncates to the limit after sorting, keeping the newest", () => {
    const merged = mergeEvents(
      [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
      [item("2026-08-12T00:00:00.000Z")],
      2,
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    ]);
  });

  it("does not mutate its inputs", () => {
    const a = [item("2026-08-10T00:00:00.000Z")];
    const frozen = Object.freeze([...a]);
    expect(() => mergeEvents(frozen, [], 5)).not.toThrow();
  });
});

describe("countUnread", () => {
  it("is zero for an operator who has never opened the panel", () => {
    // Not "everything since the beginning of time" — a bell that opens with
    // 500 in it on day one is the bell nobody reads.
    expect(countUnread([item("2026-08-14T00:00:00.000Z")], null)).toBe(0);
  });

  it("counts only events strictly newer than last seen", () => {
    const items = [
      item("2026-08-16T00:00:00.000Z"),
      item("2026-08-15T00:00:00.000Z"),
      item("2026-08-14T00:00:00.000Z"),
    ];
    expect(countUnread(items, "2026-08-15T00:00:00.000Z")).toBe(1);
  });

  it("counts nothing when last seen is newer than every event", () => {
    expect(countUnread([item("2026-08-14T00:00:00.000Z")], "2026-08-20T00:00:00.000Z")).toBe(0);
  });
});
