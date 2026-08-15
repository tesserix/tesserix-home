"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { postTicketReply, patchTicketStatus } from "@/lib/platform-api";
import { isTicketStatus } from "@/lib/tickets";

export type TicketActionResult = { ok: true } | { ok: false; message: string };

// Matches apps/web's replySchema ceiling; enforced here too so an over-long
// reply fails with a message instead of an opaque 400.
const MAX_REPLY_LENGTH = 10_000;

async function withRespond(
  run: (cookieHeader: string) => Promise<void>,
): Promise<TicketActionResult> {
  try {
    const session = await getCurrentSession();
    checkOperatorCapability(session, "respond");
    await run((await cookies()).toString());
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The reply was not saved.",
    };
  }
}

export async function replyToTicket(
  ticketId: string,
  content: string,
): Promise<TicketActionResult> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Write a reply before sending." };
  }
  if (trimmed.length > MAX_REPLY_LENGTH) {
    return { ok: false, message: "Replies are limited to 10,000 characters." };
  }
  const result = await withRespond((cookieHeader) =>
    postTicketReply(ticketId, { content: trimmed }, cookieHeader),
  );
  if (result.ok) {
    revalidatePath(`/platform/tickets/${ticketId}`);
  }
  return result;
}

export async function changeTicketStatus(
  ticketId: string,
  status: string,
): Promise<TicketActionResult> {
  if (!isTicketStatus(status)) {
    return { ok: false, message: `"${status}" is not a ticket status.` };
  }
  const result = await withRespond((cookieHeader) =>
    patchTicketStatus(ticketId, status, cookieHeader),
  );
  if (result.ok) {
    revalidatePath(`/platform/tickets/${ticketId}`);
  }
  return result;
}
