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

describe("replyToTicket with a transition", () => {
  it("sends the reply and the status as ONE request", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockResolvedValue(undefined);

    const result = await replyToTicket(TICKET_ID, "Fixed — refund is on its way.", "resolved");

    expect(result).toEqual({ ok: true });
    expect(postTicketReply).toHaveBeenCalledTimes(1);
    expect(postTicketReply).toHaveBeenCalledWith(
      TICKET_ID,
      { content: "Fixed — refund is on its way.", newStatus: "resolved" },
      "tx_session=abc",
    );
    // The whole point of the combined call: no second round trip that could
    // leave the reply sent and the ticket still open.
    expect(patchTicketStatus).not.toHaveBeenCalled();
  });

  it("sends no status at all when the operator changes none", async () => {
    signIn(["read", "respond"]);
    vi.mocked(postTicketReply).mockResolvedValue(undefined);

    await replyToTicket(TICKET_ID, "On it.");

    const payload = vi.mocked(postTicketReply).mock.calls[0][1];
    expect(payload).toEqual({ content: "On it." });
    // `toEqual` ignores an explicitly-undefined key, so assert the key is
    // absent outright — a payload carrying `newStatus: undefined` is not the
    // same wire message as one without it.
    expect(Object.keys(payload)).toEqual(["content"]);
  });

  it("rejects a transition outside the contract without sending the reply", async () => {
    signIn(["read", "respond"]);
    const result = await replyToTicket(TICKET_ID, "On it.", "reopened");
    expect(result).toEqual({ ok: false, message: `"reopened" is not a ticket status.` });
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("still re-asserts the respond capability before the combined call", async () => {
    signIn(["read"]);
    const result = await replyToTicket(TICKET_ID, "On it.", "resolved");
    expect(result.ok).toBe(false);
    expect(postTicketReply).not.toHaveBeenCalled();
  });

  it("keeps the 10,000-character ceiling when a transition is attached", async () => {
    signIn(["read", "respond"]);
    const result = await replyToTicket(TICKET_ID, "x".repeat(10_001), "resolved");
    expect(result).toEqual({
      ok: false,
      message: "Replies are limited to 10,000 characters.",
    });
    expect(postTicketReply).not.toHaveBeenCalled();
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
