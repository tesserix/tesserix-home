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

import { getCurrentSession } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readLastSeenAt,
  recentMerchantReplyRows,
  recentTicketRows,
  writeLastSeenAt,
} from "@/lib/db/notifications-repo";
import { GET, POST } from "./route";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
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

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(recentTicketRows).not.toHaveBeenCalled();
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

  it("refuses without the read capability and writes nothing", async () => {
    signIn([]);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(writeLastSeenAt).not.toHaveBeenCalled();
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
