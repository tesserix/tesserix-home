import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/search-repo", () => ({ searchTicketRows: vi.fn(async () => []) }));

import { getCurrentSession } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { searchTicketRows } from "@/lib/db/search-repo";
import { GET } from "./route";

function request(q: string): Request {
  return new Request(`https://console.tesserix.app/api/search?q=${encodeURIComponent(q)}`);
}

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1", email: "op@tesserix.app", roles, iat: 0, exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(searchTicketRows).mockResolvedValue([]);
});

describe("GET /api/search", () => {
  it("returns ticket entries for a matching query", async () => {
    signIn(["support"]);
    vi.mocked(searchTicketRows).mockResolvedValue([
      {
        id: "5f0b2c34-0000-0000-0000-000000000000",
        product_id: "mark8ly",
        ticket_number: "M8-1042",
        subject: "Payout missing",
        submitted_by_name: "Asha Pillai",
        submitted_by_email: "asha@example.com",
        status: "open",
      },
    ] as never);

    const res = await GET(request("payout"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("ticket");
    expect(body.items[0].href).toBe(
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("refuses a query shorter than the minimum without touching the database", async () => {
    signIn(["support"]);
    const res = await GET(request("p"));
    expect(res.status).toBe(400);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("trims before measuring, so whitespace is not a query", async () => {
    signIn(["support"]);
    const res = await GET(request("   "));
    expect(res.status).toBe(400);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("refuses a session without the read capability", async () => {
    signIn([]);
    const res = await GET(request("payout"));
    expect(res.status).toBe(403);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("refuses a null session", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await GET(request("payout"));
    expect(res.status).toBe(403);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("answers 501 when the database is not wired up", async () => {
    signIn(["support"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await GET(request("payout"));
    expect(res.status).toBe(501);
    expect(searchTicketRows).not.toHaveBeenCalled();
  });

  it("answers 500 without leaking the driver error", async () => {
    signIn(["support"]);
    vi.mocked(searchTicketRows).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );
    const res = await GET(request("payout"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});
