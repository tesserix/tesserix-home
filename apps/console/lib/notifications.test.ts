import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS,
  compareByAtDescending,
  countUnread,
  mergeEvents,
  toMergedProposalEvent,
  toProposalEvent,
  toReplyEvent,
  toTicketEvent,
  type NotificationItem,
} from "./notifications";
import type { Proposal } from "./secrets";

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

const PROPOSAL: Proposal = {
  number: 42,
  title: "Grant mp-payments read on mark8ly/stripe",
  url: "https://github.com/tesserix/tesserix-k8s/pull/42",
  branch: "grant/mp-payments-stripe",
  author: "someone",
  createdAt: "2026-08-16T00:00:00.000Z",
  targets: ["mark8ly/stripe"],
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

/** An `AccessProposalNotification` fixture, `at` defaulting to a real
 *  timestamp so tests that don't care about the undated case aren't
 *  accidentally exercising it. */
function proposalItem(at: string | undefined, number = 1): NotificationItem {
  return {
    id: `access_proposal_open:${number}`,
    kind: "access_proposal_open",
    number,
    title: "Grant read",
    targets: ["mark8ly/stripe"],
    at,
  };
}

describe("NOTIFICATION_KINDS", () => {
  it("lists exactly the four kinds this build understands", () => {
    // The validator in notification-bell.tsx derives its accepted-kind
    // check from this exact list — an entry dropped here silently makes a
    // real, currently-working kind read as unrecognised.
    expect(NOTIFICATION_KINDS).toEqual([
      "ticket_created",
      "merchant_reply",
      "access_proposal_open",
      "access_proposal_merged",
    ]);
  });

  it("lists the merged kind so the bell's shape validator accepts it", () => {
    expect(NOTIFICATION_KINDS).toContain("access_proposal_merged");
  });
});

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

  it("falls back to a placeholder name when the sender name is empty", () => {
    // submitted_by_name is NOT NULL but can still be the empty string.
    const e = toTicketEvent({ ...TICKET_ROW, submitted_by_name: "" });
    expect(e.actor).toBe("Unknown sender");
  });
});

describe("toReplyEvent", () => {
  it("points at the parent ticket, not the reply", () => {
    const e = toReplyEvent(REPLY_ROW);
    expect(e.ticketId).toBe(REPLY_ROW.ticket_id);
    expect(e.kind).toBe("merchant_reply");
    expect(e.actor).toBe("Asha Pillai");
  });

  it("falls back to a placeholder name when the author name is empty", () => {
    // author_name is NOT NULL but can still be the empty string.
    const e = toReplyEvent({ ...REPLY_ROW, author_name: "" });
    expect(e.actor).toBe("Merchant");
  });
});

describe("toProposalEvent", () => {
  it("maps a proposal's number, title, and targets straight through", () => {
    const e = toProposalEvent(PROPOSAL);
    expect(e.kind).toBe("access_proposal_open");
    if (e.kind !== "access_proposal_open") throw new Error("unreachable");
    expect(e.number).toBe(42);
    expect(e.title).toBe(PROPOSAL.title);
    expect(e.targets).toEqual(["mark8ly/stripe"]);
    expect(e.at).toBe(PROPOSAL.createdAt);
  });

  it("ids the event by the pull request number, not the ticket convention", () => {
    const e = toProposalEvent(PROPOSAL);
    expect(e.id).toBe("access_proposal_open:42");
  });

  it("passes an undefined createdAt straight through as undefined", () => {
    // secrets-api discards a time.Parse error upstream and this parser
    // maps the resulting zero-time literal to undefined (see
    // Proposal.createdAt's doc comment) — this mapper must not paper over
    // that with a fabricated timestamp.
    const e = toProposalEvent({ ...PROPOSAL, createdAt: undefined });
    expect(e.at).toBeUndefined();
  });
});

describe("toMergedProposalEvent", () => {
  it("builds a merged event addressed to the requester", () => {
    const event = toMergedProposalEvent({
      number: 7,
      title: "grant ns/app",
      url: "u",
      branch: "b",
      author: "bot",
      targets: ["ns/app"],
      requestedBy: "subject-9",
      mergedAt: "2026-09-01T10:00:00Z",
    });
    expect(event).toEqual({
      id: "access_proposal_merged:7",
      kind: "access_proposal_merged",
      number: 7,
      title: "grant ns/app",
      targets: ["ns/app"],
      recipientSub: "subject-9",
      at: "2026-09-01T10:00:00Z",
    });
  });

  it("builds nothing for a proposal with no requester", () => {
    // The security-relevant case: an unaddressed item must not exist at all,
    // because an item with no recipient cannot be filtered to one.
    expect(
      toMergedProposalEvent({
        number: 8,
        title: "t",
        url: "u",
        branch: "b",
        author: "bot",
        targets: [],
        mergedAt: "2026-09-01T10:00:00Z",
      }),
    ).toBeUndefined();
  });

  it("builds nothing for a proposal with no merge time", () => {
    expect(
      toMergedProposalEvent({
        number: 9,
        title: "t",
        url: "u",
        branch: "b",
        author: "bot",
        targets: [],
        requestedBy: "subject-9",
      }),
    ).toBeUndefined();
  });

  it("lists the merged kind so the bell's shape validator accepts it", () => {
    expect(NOTIFICATION_KINDS).toContain("access_proposal_merged");
  });
});

describe("mergeEvents", () => {
  it("interleaves both sources newest first", () => {
    const merged = mergeEvents(
      [
        [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
        [item("2026-08-12T00:00:00.000Z")],
      ],
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
      [
        [item("2026-08-10T00:00:00.000Z"), item("2026-08-14T00:00:00.000Z")],
        [item("2026-08-12T00:00:00.000Z")],
      ],
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
    expect(() => mergeEvents([frozen, []], 5)).not.toThrow();
  });

  it("merges three or more sources, still newest-first and truncated after sorting", () => {
    // The feed is gaining a third source (access proposals); this is the
    // generalization the two-array signature could not express.
    const merged = mergeEvents(
      [
        [item("2026-08-10T00:00:00.000Z")],
        [item("2026-08-14T00:00:00.000Z")],
        [item("2026-08-12T00:00:00.000Z"), item("2026-08-09T00:00:00.000Z")],
      ],
      3,
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ]);
  });

  it("sorts an undated proposal to the bottom of a newest-first list, not the top", () => {
    // Ruling: an undated item (a proposal whose upstream timestamp failed to
    // parse) is treated as the OLDEST thing in the list, never the newest —
    // an accidental empty-string-style comparison would instead leave it in
    // whatever order Array.flat() produced, or worse, at the top.
    const merged = mergeEvents(
      [[proposalItem(undefined, 1), item("2026-08-10T00:00:00.000Z")]],
      10,
    );
    expect(merged.map((e) => e.id)).toEqual([
      "2026-08-10T00:00:00.000Z",
      "access_proposal_open:1",
    ]);
  });

  it("keeps two undated items stable relative to each other, via a comparator that reports them equal", () => {
    // This exercises the same input as before (two undated items through
    // mergeEvents), but the previous version of this test asserted the
    // observed order rather than the comparator's actual return value —
    // which meant it could not distinguish a correct `return 0` from a
    // broken comparator, because V8's small-array insertion sort never
    // queries both `cmp(a, b)` and `cmp(b, a)` for a 2-element array, so a
    // asymmetric comparator (which is inconsistent, not "unordered") would
    // still have produced this same stable-looking output. See the
    // `compareByAtDescending` symmetry test below for the assertion that
    // actually catches that.
    const merged = mergeEvents(
      [[proposalItem(undefined, 1), proposalItem(undefined, 2)]],
      10,
    );
    expect(merged.map((e) => e.id)).toEqual([
      "access_proposal_open:1",
      "access_proposal_open:2",
    ]);
  });
});

describe("compareByAtDescending", () => {
  it("reports two undated items equal in both comparison directions", () => {
    // This is the property `sort()` cannot be trusted to check (see the
    // comment above): a comparator that returns a nonzero, non-symmetric
    // value for one direction only (e.g. 1 for both (x, y) and (y, x), which
    // is what deleting the guard line's `return 0` and falling through to
    // "b === undefined ? -1" branches would produce) breaks `Array.sort`'s
    // contract even though a 2-element `sort()` call might not visibly
    // reorder anything. Asserting both directions directly, and their
    // relationship to each other, is what actually pins the guard line
    // down.
    const a = proposalItem(undefined, 1);
    const b = proposalItem(undefined, 2);
    // Both directions must report "equal" — a comparator that returns a
    // nonzero value for one or both directions here is broken, whether or
    // not that break happens to be symmetric.
    expect(compareByAtDescending(a, b)).toBe(0);
    expect(compareByAtDescending(b, a)).toBe(0);
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

  it("never counts an undated proposal as unread, even with a real last-seen value", () => {
    // Ruling: an item with no `at` can never be PROVEN newer than
    // lastSeenAt, so it must never inflate the badge — a bell that cannot
    // be cleared for one specific item is the failure this function's own
    // null-lastSeenAt case already guards against.
    expect(
      countUnread([proposalItem(undefined, 1)], "2026-08-01T00:00:00.000Z"),
    ).toBe(0);
  });

  it("never counts an undated proposal as unread for an operator who has never opened the panel", () => {
    expect(countUnread([proposalItem(undefined, 1)], null)).toBe(0);
  });
});
