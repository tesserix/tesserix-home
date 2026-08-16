import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ toString: (): string => "tx_session=abc" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  postTicketReply: vi.fn(),
  patchTicketStatus: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { postTicketReply, patchTicketStatus } from "@/lib/platform-api";
import { replyToTicket, changeTicketStatus } from "./actions";

const TICKET_ID = "5f0b2c34-0000-0000-0000-000000000000";

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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("replyToTicket", () => {
  it("posts the reply with the operator's cookie and revalidates", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockResolvedValue(undefined);

    const result = await replyToTicket(TICKET_ID, "On it.");

    expect(result).toEqual({ ok: true });
    expect(postTicketReply).toHaveBeenCalledWith(
      TICKET_ID,
      { content: "On it." },
      "tx_session=abc",
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/tickets/${TICKET_ID}`);
  });

  it("refuses without the respond capability, before any transport call", async () => {
    signIn(["read"]);
    const result = await replyToTicket(TICKET_ID, "On it.");
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to respond to tickets.",
    });
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("rejects an empty reply without calling the API", async () => {
    signIn(["read", "respond"]);
    const result = await replyToTicket(TICKET_ID, "   ");
    expect(result.ok).toBe(false);
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("maps a transport failure to a generic message, not the raw error", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockRejectedValue(new Error("boom"));
    const result = await replyToTicket(TICKET_ID, "On it.");
    expect(result).toEqual({ ok: false, message: "The reply was not saved." });
  });
});

describe("changeTicketStatus", () => {
  it("patches a valid status and revalidates", async () => {
    signIn(["read", "respond"]);
    vi.mocked(patchTicketStatus).mockResolvedValue(undefined);

    const result = await changeTicketStatus(TICKET_ID, "resolved");

    expect(result).toEqual({ ok: true });
    expect(patchTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      "resolved",
      "tx_session=abc",
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/tickets/${TICKET_ID}`);
  });

  it("rejects a status outside the contract without calling the API", async () => {
    signIn(["read", "respond"]);
    const result = await changeTicketStatus(TICKET_ID, "reopened");
    expect(result.ok).toBe(false);
    expect(patchTicketStatus).not.toHaveBeenCalled();
  });

  it("refuses without the respond capability", async () => {
    signIn(["read"]);
    const result = await changeTicketStatus(TICKET_ID, "resolved");
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to respond to tickets.",
    });
    expect(patchTicketStatus).not.toHaveBeenCalled();
  });

  it("maps a transport failure to a generic message, not the raw error", async () => {
    signIn(["read", "respond"]);
    vi.mocked(patchTicketStatus).mockRejectedValue(new Error("boom"));
    const result = await changeTicketStatus(TICKET_ID, "resolved");
    expect(result).toEqual({ ok: false, message: "The status was not changed." });
  });
});
