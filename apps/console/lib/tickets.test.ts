import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api";
import {
  parseTickets,
  severityOf,
  ticketKey,
  parseTicketDetail,
  isTicketStatus,
  ticketStatusLabel,
  ticketStatusTone,
  isTerminalStatus,
  parseTicketList,
  parseTicketsSummary,
} from "./tickets";

const PAYLOAD = {
  summary: { open: 23, inProgress: 4, resolvedThisWeek: 11, urgentOpen: 4 },
  rows: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      product_id: "mark8ly",
      tenant_id: "22222222-2222-2222-2222-222222222222",
      ticket_number: "M8-1042",
      subject: "Payouts stuck since Tuesday",
      status: "open",
      priority: "urgent",
      submitted_by_name: "Bondi Store",
      submitted_by_email: "ops@bondi.example",
      created_at: "2026-08-15T09:00:00.000Z",
      updated_at: "2026-08-15T09:30:00.000Z",
    },
  ],
  generatedAt: "2026-08-15T12:00:00.000Z",
};

describe("parseTickets", () => {
  it("reads the summary and rows apps/web returns", () => {
    const page = parseTickets(PAYLOAD);
    expect(page.summary.urgentOpen).toBe(4);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].ticketNumber).toBe("M8-1042");
    expect(page.rows[0].productId).toBe("mark8ly");
  });

  it("accepts camelCase as well as snake_case", () => {
    // The listing route returns snake_case straight from Postgres today, but
    // the shape is not contractual — tolerating both means a future rename on
    // the API side does not blank the queue.
    const page = parseTickets({
      summary: PAYLOAD.summary,
      rows: [
        {
          ...PAYLOAD.rows[0],
          product_id: undefined,
          productId: "kora",
          ticket_number: undefined,
          ticketNumber: "KO-7",
          created_at: undefined,
          createdAt: "2026-08-15T09:00:00.000Z",
        },
      ],
    });
    expect(page.rows[0].productId).toBe("kora");
    expect(page.rows[0].ticketNumber).toBe("KO-7");
  });

  it.each([
    ["a missing summary", { rows: [] }],
    ["a non-numeric count", { summary: { ...PAYLOAD.summary, open: "23" }, rows: [] }],
    ["rows that are not an array", { summary: PAYLOAD.summary, rows: {} }],
    [
      "a row missing its subject",
      {
        summary: PAYLOAD.summary,
        rows: [{ ...PAYLOAD.rows[0], subject: undefined }],
      },
    ],
  ])("rejects %s rather than coercing it", (_label, payload) => {
    // A queue that renders a blank row for a malformed ticket is worse than one
    // that errors: the blank row looks handled.
    expect(() => parseTickets(payload)).toThrow(PlatformApiError);
  });
});

describe("severityOf", () => {
  it("escalates urgent and high", () => {
    expect(severityOf("urgent")).toBe("critical");
    expect(severityOf("high")).toBe("warning");
  });

  it("treats everything else as normal", () => {
    for (const p of ["medium", "low", "", "banana"]) {
      expect(severityOf(p)).toBe("normal");
    }
  });

  it("is case-insensitive", () => {
    expect(severityOf("URGENT")).toBe("critical");
  });
});

describe("ticketKey", () => {
  it("keys on product and ticket number, not the UUID", () => {
    // QueueItem.key is documented as opaque for exactly this: a human
    // identifies a ticket by (product, number), and a duplicate is invisible in
    // a list keyed by UUID.
    const [row] = parseTickets(PAYLOAD).rows;
    expect(ticketKey(row)).toBe("mark8ly:M8-1042");
  });

  it("distinguishes the same number across products", () => {
    const a = { productId: "mark8ly", ticketNumber: "1042" } as never;
    const b = { productId: "kora", ticketNumber: "1042" } as never;
    expect(ticketKey(a)).not.toBe(ticketKey(b));
  });
});

describe("parseTicketDetail", () => {
  const VALID_DETAIL = {
    ticket: {
      id: "5f0b2c34-0000-0000-0000-000000000000",
      product_id: "mark8ly",
      tenant_id: "9a1e0000-0000-0000-0000-000000000000",
      ticket_number: "M8-1042",
      subject: "Payout missing",
      description: "The Friday payout never arrived.",
      status: "open",
      priority: "urgent",
      submitted_by_name: "Asha Pillai",
      submitted_by_email: "asha@example.com",
      submitted_by_user_id: null,
      resolved_at: null,
      created_at: "2026-08-10T04:00:00.000Z",
      updated_at: "2026-08-11T04:00:00.000Z",
    },
    replies: [
      {
        id: "77770000-0000-0000-0000-000000000000",
        ticket_id: "5f0b2c34-0000-0000-0000-000000000000",
        author_type: "platform_admin",
        author_name: "Mahesh",
        author_email: "mahesh.sangawar@gmail.com",
        author_user_id: "sub-123",
        content: "Looking into it now.",
        created_at: "2026-08-11T04:00:00.000Z",
      },
    ],
  };

  it("parses ticket, description and replies", () => {
    const detail = parseTicketDetail(VALID_DETAIL);
    expect(detail.ticket.subject).toBe("Payout missing");
    expect(detail.ticket.description).toBe("The Friday payout never arrived.");
    expect(detail.ticket.resolvedAt).toBeNull();
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0].authorType).toBe("platform_admin");
    expect(detail.replies[0].content).toBe("Looking into it now.");
  });

  it("tolerates a null author_email by rendering it as empty", () => {
    const detail = parseTicketDetail({
      ...VALID_DETAIL,
      replies: [{ ...VALID_DETAIL.replies[0], author_email: null }],
    });
    expect(detail.replies[0].authorEmail).toBe("");
  });

  it("rejects an unknown author_type rather than coercing it", () => {
    // author_type drives who a message is attributed to in the thread; a
    // wrong guess misattributes a customer's words to an operator.
    expect(() =>
      parseTicketDetail({
        ...VALID_DETAIL,
        replies: [{ ...VALID_DETAIL.replies[0], author_type: "bot" }],
      }),
    ).toThrow(PlatformApiError);
  });

  it("rejects a payload with no ticket object", () => {
    expect(() => parseTicketDetail({ replies: [] })).toThrow(PlatformApiError);
  });
});

describe("isTicketStatus", () => {
  it("accepts the four contract statuses", () => {
    for (const s of ["open", "in_progress", "resolved", "closed"]) {
      expect(isTicketStatus(s)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isTicketStatus("reopened")).toBe(false);
    expect(isTicketStatus("")).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("treats resolved and closed as terminal", () => {
    expect(isTerminalStatus("resolved")).toBe(true);
    expect(isTerminalStatus("closed")).toBe(true);
  });

  it("leaves live tickets alone", () => {
    expect(isTerminalStatus("open")).toBe(false);
    expect(isTerminalStatus("in_progress")).toBe(false);
    expect(isTerminalStatus("")).toBe(false);
  });

  it("ignores casing, as the API carries the status through unnormalised", () => {
    expect(isTerminalStatus("Resolved")).toBe(true);
    expect(isTerminalStatus("CLOSED")).toBe(true);
  });
});

describe("ticketStatusLabel", () => {
  it("turns the database's snake_case into something a human reads", () => {
    expect(ticketStatusLabel("in_progress")).toBe("In progress");
    expect(ticketStatusLabel("open")).toBe("Open");
  });

  it("passes an unknown status through rather than hiding it", () => {
    // The column carries whatever the database holds; a status nobody has
    // named is still worth showing.
    expect(ticketStatusLabel("escalated")).toBe("Escalated");
  });
});

describe("ticketStatusTone", () => {
  it("gives each contract status its own reading", () => {
    expect(ticketStatusTone("open")).toBe("info");
    expect(ticketStatusTone("in_progress")).toBe("warning");
    expect(ticketStatusTone("resolved")).toBe("success");
    expect(ticketStatusTone("closed")).toBe("neutral");
  });

  it("treats an unknown status as unclassified, not as an alarm", () => {
    expect(ticketStatusTone("escalated")).toBe("neutral");
  });

  it("ignores casing, like every other status reader here", () => {
    expect(ticketStatusTone("In_Progress")).toBe("warning");
  });
});

// ---- the platform API's shape (#269) -----------------------------------

const MODULE_ROW = {
  id: "3f2a1c94-0000-4000-8000-000000000001",
  product_id: "mark8ly",
  tenant_id: "3f2a1c94-0000-4000-8000-0000000000aa",
  ticket_number: "M8-0001",
  subject: "Payouts delayed again",
  description: "Third week running.",
  status: "open",
  priority: "urgent",
  submitted_by_name: "Amber Rowe",
  submitted_by_email: "amber@amber.test",
  resolved_at: null,
  created_at: "2026-08-19T06:00:00Z",
  updated_at: "2026-08-19T06:30:00Z",
};

describe("parseTicketList", () => {
  it("accepts the module's listing", () => {
    const rows = parseTicketList({ tickets: [MODULE_ROW] });

    expect(rows).toHaveLength(1);
    expect(rows[0].ticketNumber).toBe("M8-0001");
    expect(rows[0].productId).toBe("mark8ly");
    expect(rows[0].submittedByEmail).toBe("amber@amber.test");
  });

  it("accepts an empty queue as an empty list, not a failure", () => {
    expect(parseTicketList({ tickets: [] })).toEqual([]);
  });

  it("rejects a payload with no tickets key rather than rendering nothing", () => {
    // An empty queue and a broken contract look identical on screen. Only one
    // of them should be silent.
    expect(() => parseTicketList({ rows: [] })).toThrow(PlatformApiError);
  });

  it("rejects a row missing its identity", () => {
    const { ticket_number: _dropped, ...withoutNumber } = MODULE_ROW;
    expect(() => parseTicketList({ tickets: [withoutNumber] })).toThrow(
      PlatformApiError,
    );
  });

  it("reads the same row parser as the legacy listing", () => {
    // Both backends exist at once, so the one thing that must not differ is
    // what a ticket IS. Asserted by parsing the same row through both.
    const viaModule = parseTicketList({ tickets: [MODULE_ROW] })[0];
    const viaWeb = parseTickets({
      summary: { open: 1, inProgress: 0, resolvedThisWeek: 0, urgentOpen: 0 },
      rows: [MODULE_ROW],
    }).rows[0];

    expect(viaModule).toEqual(viaWeb);
  });
});

describe("parseTicketsSummary", () => {
  it("maps the module's snake_case onto the console's names", () => {
    const summary = parseTicketsSummary({
      summary: { open: 3, in_progress: 1, resolved_this_week: 2, urgent_open: 1 },
    });

    expect(summary).toEqual({
      open: 3,
      inProgress: 1,
      resolvedThisWeek: 2,
      urgentOpen: 1,
    });
  });

  it("rejects a missing count rather than defaulting it to zero", () => {
    // A headline number that silently reads zero is worse than a visible
    // failure: an empty queue and a broken read look the same to an operator.
    expect(() =>
      parseTicketsSummary({ summary: { open: 3, in_progress: 1, resolved_this_week: 2 } }),
    ).toThrow(PlatformApiError);
  });

  it("rejects camelCase, which is the legacy endpoint's spelling", () => {
    // Guards the direction of the mapping. If this ever silently accepted
    // both, a wiring mistake that pointed the module parser at apps/web's
    // payload would go unnoticed.
    expect(() =>
      parseTicketsSummary({
        summary: { open: 3, inProgress: 1, resolvedThisWeek: 2, urgentOpen: 1 },
      }),
    ).toThrow(PlatformApiError);
  });
});
