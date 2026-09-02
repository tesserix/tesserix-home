import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/notifications-repo", () => ({
  recentTicketRows: vi.fn(async () => []),
  recentMerchantReplyRows: vi.fn(async () => []),
  readLastSeenAt: vi.fn(async () => null),
  writeLastSeenAt: vi.fn(async () => {}),
}));
vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchProposals: vi.fn(async () => []),
  fetchMergedProposals: vi.fn(async () => []),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
  writeLastSeenAt,
} from "@/lib/db/notifications-repo";
import { fetchMergedProposals, fetchProposals } from "@/lib/secrets-api";
import { FEED_LIMIT } from "@/lib/notifications";
import { GET, POST } from "./route";

function signIn(roles: readonly string[] | undefined, sub = "sub-1") {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub,
    email: "op@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(recentTicketRows).mockResolvedValue([]);
  vi.mocked(recentMerchantReplyRows).mockResolvedValue([]);
  vi.mocked(readLastSeenAt).mockResolvedValue(null);
  vi.mocked(fetchProposals).mockResolvedValue([]);
  vi.mocked(fetchMergedProposals).mockResolvedValue([]);
});

describe("GET /api/notifications", () => {
  it("returns the merged feed with a derived unread count", async () => {
    signIn(["support"]);
    vi.mocked(readLastSeenAt).mockResolvedValue("2026-08-15T00:00:00.000Z");
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha",
        created_at: "2026-08-16T00:00:00.000Z",
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ticketId).toBe("5f0b2c34-0000-0000-0000-000000000000");
    expect(body.unread).toBe(1);
  });

  it("answers 501 when the database is not wired up yet", async () => {
    // The window before the chart change deploys. 501 is the estate's
    // "data plane parked" signal, distinct from a real failure.
    signIn(["support"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(501);
    expect(recentTicketRows).not.toHaveBeenCalled();
  });

  it("answers 200 with an empty feed for a session holding no relevant capability", async () => {
    // The property this task introduces: entry to the feed is console entry,
    // not `support`. Holding no capability the feed answers to means nothing
    // is addressed to this operator — not that they may not enter.
    signIn([]);
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha",
        created_at: "2026-08-16T00:00:00.000Z",
      },
    ] as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.unread).toBe(0);
  });

  it("does not count an unseen ticket row for an operator who cannot see ticket kinds", async () => {
    // The badge's honesty rests on this: countUnread must run AFTER
    // filtering, or the bell promises a count the panel will never show.
    signIn([]);
    vi.mocked(readLastSeenAt).mockResolvedValue("2026-08-15T00:00:00.000Z");
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha",
        created_at: "2026-08-16T00:00:00.000Z",
      },
    ] as never);
    const res = await GET();
    const body = await res.json();
    expect(body.unread).toBe(0);
  });

  const TICKET_ROW = {
    id: "5f0b2c34-0000-0000-0000-000000000000",
    product_id: "mark8ly",
    ticket_number: "M8-1042",
    subject: "Payout missing",
    submitted_by_name: "Asha",
    created_at: "2026-08-16T00:00:00.000Z",
  };

  const PROPOSAL = {
    number: 7,
    title: "Grant mp-payments read on mark8ly/stripe",
    url: "https://github.com/tesserix/tesserix-k8s/pull/7",
    branch: "grant/mp-payments-stripe",
    author: "someone",
    createdAt: "2026-08-16T00:00:00.000Z",
    targets: ["mark8ly/stripe"],
  };

  it("shows an operator only the kinds their held capabilities admit: support sees tickets, not proposals", async () => {
    // The case Task 3 could not construct with one capability in play: an
    // operator holding `support` but NOT `rotate-credentials` sees ticket
    // rows and no proposals.
    signIn(["support"]);
    vi.mocked(recentTicketRows).mockResolvedValue([TICKET_ROW] as never);
    vi.mocked(fetchProposals).mockResolvedValue([PROPOSAL] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("ticket_created");
  });

  it("shows an operator only the kinds their held capabilities admit: rotate-credentials sees proposals, not tickets", async () => {
    // The mirror case: an operator holding `rotate-credentials` but NOT
    // `support` sees proposals and no ticket rows.
    signIn(["rotate-credentials"]);
    vi.mocked(recentTicketRows).mockResolvedValue([TICKET_ROW] as never);
    vi.mocked(fetchProposals).mockResolvedValue([PROPOSAL] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("access_proposal_open");
    expect(body.items[0].number).toBe(7);
  });

  it("gates the proposal kind on rotate-credentials, the verb, not on platform, the surface", async () => {
    // An operator holding `platform` alone (no relevant capability here)
    // can open the reviews queue page and look, but cannot act on an
    // entry — so no proposal notification is addressed to them.
    signIn(["platform"]);
    vi.mocked(fetchProposals).mockResolvedValue([PROPOSAL] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("still returns the ticket rows, at 200, when the proposals leg rejects", async () => {
    // secrets-api answers 501 (SECRETS_API_ORIGIN unset) or 503 (no review
    // repository configured) today — neither may cost the operator their
    // ticket notifications. The proposals leg is contained on its own.
    signIn(["support", "rotate-credentials"]);
    vi.mocked(recentTicketRows).mockResolvedValue([TICKET_ROW] as never);
    vi.mocked(fetchProposals).mockRejectedValue(new Error("secrets-api returned 503"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("ticket_created");
  });

  it("does not let an unbounded proposals source starve out tickets for an operator who cannot see proposals", async () => {
    // IMPORTANT 1: fetchProposals() is unbounded — it returns every open
    // grant/* pull request, not capped by a repo-level LIMIT the way the
    // ticket/reply queries are. Before this fix, mergeEvents() ran on the
    // full merged list BEFORE capability filtering: with more than
    // FEED_LIMIT proposals, all newer than the ticket rows, the proposals
    // would fill every slot of the truncated list, and a `support`-only
    // operator's filter would then remove every one of them — leaving a
    // "nothing waiting" feed with real, unshown tickets past the truncation
    // point. Filtering before merging is what this test pins down.
    signIn(["support"]);
    const manyProposals = Array.from({ length: FEED_LIMIT + 5 }, (_, i) => ({
      ...PROPOSAL,
      number: 1000 + i,
      // Newer than every ticket row below, so an unfiltered merge would sort
      // every one of these ahead of the tickets.
      createdAt: `2026-08-20T00:00:00.${String(i).padStart(3, "0")}Z`,
    }));
    vi.mocked(fetchProposals).mockResolvedValue(manyProposals as never);
    vi.mocked(recentTicketRows).mockResolvedValue([TICKET_ROW] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("ticket_created");
  });

  it("answers 500 without leaking the driver error when a query fails", async () => {
    signIn(["support"]);
    vi.mocked(recentTicketRows).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("refuses GET when the session is null", async () => {
    // Middleware already gates /api/*, but a surface leaning on routing for
    // authorization stops being safe the moment the matcher changes. The handler
    // must fail closed on its own.
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(recentTicketRows).not.toHaveBeenCalled();
  });

  const MERGED_PROPOSAL = {
    number: 7,
    title: "grant ns/app",
    url: "https://github.com/tesserix/tesserix-k8s/pull/7",
    branch: "secret-service/ns-app",
    author: "tesserix-bot",
    targets: ["ns/app"],
    requestedBy: "sub-9",
    mergedAt: "2026-09-01T10:00:00Z",
  };

  function mergedItems(body: { items: { kind: string }[] }) {
    return body.items.filter((i) => i.kind === "access_proposal_merged");
  }

  it("hides a merged notification from an operator who is not its recipient", async () => {
    // The security assertion of this change: platform alone must not show one
    // operator what another asked for.
    signIn(["platform"], "sub-OTHER");
    vi.mocked(fetchMergedProposals).mockResolvedValue([MERGED_PROPOSAL] as never);

    const body = await (await GET()).json();

    expect(mergedItems(body)).toHaveLength(0);
  });

  it("shows a merged notification to the operator who raised it", async () => {
    signIn(["platform"], "sub-9");
    vi.mocked(fetchMergedProposals).mockResolvedValue([MERGED_PROPOSAL] as never);

    const body = await (await GET()).json();

    expect(mergedItems(body)).toHaveLength(1);
    expect(mergedItems(body)[0]).toMatchObject({
      number: 7,
      recipientSub: "sub-9",
      at: "2026-09-01T10:00:00Z",
    });
  });

  it("leaves capability-addressed kinds unaffected by the recipient check", async () => {
    // A ticket carries no recipientSub and must still reach a support holder
    // whose subject matches nothing in the feed.
    signIn(["support"], "sub-OTHER");
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "t1",
        product_id: "homechef",
        ticket_number: 12,
        subject: "printer on fire",
        created_at: "2026-09-01T09:00:00Z",
      } as never,
    ]);

    const body = await (await GET()).json();

    expect(body.items.filter((i: { kind: string }) => i.kind === "ticket_created")).toHaveLength(1);
  });

  it("keeps the ticket rows when the merged leg fails", async () => {
    // Same guarantee safeProposalEvents already gives: one leg's 501/503/timeout
    // must not cost the operator the rest of the response.
    signIn(["support", "platform"], "sub-9");
    vi.mocked(fetchMergedProposals).mockRejectedValue(new Error("secrets-api unreachable"));
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "t1",
        product_id: "homechef",
        ticket_number: 12,
        subject: "printer on fire",
        created_at: "2026-09-01T09:00:00Z",
      } as never,
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.filter((i: { kind: string }) => i.kind === "ticket_created")).toHaveLength(1);
    expect(mergedItems(body)).toHaveLength(0);
  });

  it("does not starve an operator's own merge out of a 20-slot-deep window", async () => {
    // Round 1, Finding 1: fetchMergedProposals returns merges for EVERY
    // operator, not just the caller's. If the leg capped itself at
    // FEED_LIMIT before the recipient filter ran, a viewer whose own merge
    // sorted past index FEED_LIMIT - 1 would never see it, no matter how
    // recent. The leg must return everything and let the per-recipient
    // filter, then mergeEvents, do the bounding.
    signIn(["platform"], "sub-9");
    const others = Array.from({ length: FEED_LIMIT + 4 }, (_, i) => ({
      ...MERGED_PROPOSAL,
      number: 2000 + i,
      requestedBy: "sub-OTHER",
      // Newer than the viewer's own merge below, so an unfiltered
      // slice-then-filter would push it out first.
      mergedAt: `2026-09-01T11:00:00.${String(i).padStart(3, "0")}Z`,
    }));
    const own = { ...MERGED_PROPOSAL, number: 9999, requestedBy: "sub-9", mergedAt: "2026-09-01T10:00:00Z" };
    vi.mocked(fetchMergedProposals).mockResolvedValue([...others, own] as never);

    const body = await (await GET()).json();

    expect(mergedItems(body)).toHaveLength(1);
    expect(mergedItems(body)[0]).toMatchObject({ number: 9999, recipientSub: "sub-9" });
  });

  it("denies a merged notification to an operator who lacks platform, even for their own proposal", async () => {
    // Round 1, Finding 2: the capability half of the AND needs its own
    // negative test — nothing previously asserted that holding a DIFFERENT
    // capability than `platform` still denies the viewer's own merge.
    signIn(["support"], "sub-9");
    vi.mocked(fetchMergedProposals).mockResolvedValue([MERGED_PROPOSAL] as never);

    const body = await (await GET()).json();

    expect(mergedItems(body)).toHaveLength(0);
  });

  it("hides everything, including capability-addressed kinds, for a session with an empty sub", async () => {
    // `verifySession` only requires `typeof sub === "string"`, so `sub: ""`
    // typechecks through it. The `!sub` guard in `visibleTo` is what stops
    // that from reaching a capability-only check and showing every
    // capability-addressed item (tickets included) to a session with no
    // real identity to gate a recipient check against.
    signIn(["support", "platform"], "");
    vi.mocked(recentTicketRows).mockResolvedValue([
      {
        id: "t1",
        product_id: "homechef",
        ticket_number: 12,
        subject: "printer on fire",
        created_at: "2026-09-01T09:00:00Z",
      } as never,
    ]);
    vi.mocked(fetchMergedProposals).mockResolvedValue([MERGED_PROPOSAL] as never);

    const body = await (await GET()).json();

    expect(body.items).toHaveLength(0);
  });

  it("shows exactly the viewer's own item out of a mixed batch, not the other operator's", async () => {
    // Round 1, Finding 3: every prior merged test fed a homogeneous batch,
    // so an all-or-nothing filter bug (filtering the wrong array, `some`
    // instead of `filter`) would have passed all of them.
    signIn(["platform"], "sub-9");
    vi.mocked(fetchMergedProposals).mockResolvedValue([
      MERGED_PROPOSAL,
      { ...MERGED_PROPOSAL, number: 8, requestedBy: "sub-OTHER" },
    ] as never);

    const body = await (await GET()).json();

    expect(mergedItems(body)).toHaveLength(1);
    expect(mergedItems(body)[0]).toMatchObject({ recipientSub: "sub-9" });
  });
});

describe("POST /api/notifications", () => {
  it("writes last-seen and returns it", async () => {
    signIn(["support"]);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(writeLastSeenAt).toHaveBeenCalledWith("sub-1", body.lastSeenAt);
    expect(body.ok).toBe(true);
  });

  it("still writes last-seen for a session holding no relevant capability", async () => {
    // Marking the feed seen requires console entry only, same as reading it —
    // a session with no `support` grant may still clear the badge.
    signIn([]);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(writeLastSeenAt).toHaveBeenCalled();
  });

  it("answers 501 rather than writing when the database is not wired up", async () => {
    signIn(["support"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await POST();
    expect(res.status).toBe(501);
    expect(writeLastSeenAt).not.toHaveBeenCalled();
  });

  it("refuses POST when the session is null", async () => {
    // Middleware already gates /api/*, but a surface leaning on routing for
    // authorization stops being safe the moment the matcher changes. The handler
    // must fail closed on its own.
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(writeLastSeenAt).not.toHaveBeenCalled();
  });
});
