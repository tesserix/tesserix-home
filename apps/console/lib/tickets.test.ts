import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api";
import { parseTickets, severityOf, ticketKey } from "./tickets";

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
