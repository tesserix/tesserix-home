import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tesserix")>()),
  tesserixQuery: vi.fn(),
}));

import { tesserixQuery } from "./tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
} from "./notifications-repo";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recentTicketRows", () => {
  it("normalises a pg Date created_at to an ISO string", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha Pillai",
        created_at: new Date("2026-08-14T04:00:00.000Z"),
      },
    ] as never);

    const rows = await recentTicketRows("2026-08-01T00:00:00.000Z", 20);

    expect(rows[0].created_at).toBe("2026-08-14T04:00:00.000Z");
    expect(typeof rows[0].created_at).toBe("string");
  });

  it("passes through a string created_at as a normalised ISO string", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha Pillai",
        created_at: "2026-08-14T04:00:00.000Z",
      },
    ] as never);

    const rows = await recentTicketRows("2026-08-01T00:00:00.000Z", 20);

    expect(rows[0].created_at).toBe("2026-08-14T04:00:00.000Z");
  });
});

describe("recentMerchantReplyRows", () => {
  it("normalises a pg Date created_at to an ISO string", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        id: "77770000-0000-0000-0000-000000000000",
        ticket_id: "5f0b2c34-0000-0000-0000-000000000000",
        author_name: "Asha Pillai",
        created_at: new Date("2026-08-15T04:00:00.000Z"),
        ticket_number: "M8-1042",
        product_id: "mark8ly",
        subject: "Payout missing",
      },
    ] as never);

    const rows = await recentMerchantReplyRows("2026-08-01T00:00:00.000Z", 20);

    expect(rows[0].created_at).toBe("2026-08-15T04:00:00.000Z");
    expect(typeof rows[0].created_at).toBe("string");
  });
});

describe("readLastSeenAt", () => {
  it("normalises a pg Date last_seen_at to an ISO string", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      { last_seen_at: new Date("2026-08-15T00:00:00.000Z") },
    ] as never);

    const lastSeenAt = await readLastSeenAt("user-1");

    expect(lastSeenAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("returns null, not undefined, when no row comes back", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    const lastSeenAt = await readLastSeenAt("user-1");

    expect(lastSeenAt).toBeNull();
  });
});
