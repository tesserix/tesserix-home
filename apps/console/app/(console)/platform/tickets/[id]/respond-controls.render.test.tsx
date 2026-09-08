// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  changeTicketStatus: vi.fn(async () => ({ ok: true })),
  replyToTicket: vi.fn(async () => ({ ok: true })),
}));

import { changeTicketStatus, replyToTicket } from "./actions";
import { ReplyForm, StatusControl } from "./respond-controls";

const TICKET_ID = "5f0b2c34-0000-0000-0000-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StatusControl", () => {
  it.each(["open", "in_progress"])(
    "offers the status dropdown and no Reopen on %s",
    (status) => {
      render(<StatusControl ticketId={TICKET_ID} status={status} />);
      expect(screen.getByLabelText("Ticket status")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
    },
  );

  it.each(["resolved", "closed"])("offers Reopen and no dropdown on %s", (status) => {
    render(<StatusControl ticketId={TICKET_ID} status={status} />);
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Ticket status")).toBeNull();
  });

  it("treats an oddly-cased terminal status as terminal", () => {
    // The API carries status through as a free string; a "Resolved" that fell
    // out of the terminal set would silently restore the dropdown.
    render(<StatusControl ticketId={TICKET_ID} status="Resolved" />);
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });

  it("reopens to open, not to some other status", async () => {
    render(<StatusControl ticketId={TICKET_ID} status="resolved" />);
    await userEvent.click(screen.getByRole("button", { name: /reopen/i }));
    expect(changeTicketStatus).toHaveBeenCalledWith(TICKET_ID, "open");
  });
});

describe("ReplyForm", () => {
  it("sends no transition by default", async () => {
    render(<ReplyForm ticketId={TICKET_ID} />);
    await userEvent.type(screen.getByLabelText("Reply"), "On it.");
    await userEvent.click(screen.getByRole("button", { name: /send reply/i }));

    expect(replyToTicket).toHaveBeenCalledWith(TICKET_ID, "On it.", undefined);
  });

  it("sends the chosen transition with the reply", async () => {
    render(<ReplyForm ticketId={TICKET_ID} />);
    await userEvent.type(screen.getByLabelText("Reply"), "Refunded.");
    // Drives the design system's `Select` — a Radix combobox, not a native
    // `<select>`, so `selectOptions` has no `<option>` to select (#592). Open
    // the trigger, then click the option by its VISIBLE label, exactly as an
    // operator does; the wire value is `resolved`, asserted below.
    await userEvent.click(screen.getByLabelText("Status on send"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Mark resolved on send" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /send reply/i }));

    expect(replyToTicket).toHaveBeenCalledTimes(1);
    expect(replyToTicket).toHaveBeenCalledWith(TICKET_ID, "Refunded.", "resolved");
  });

  it("does not offer closing a ticket straight from the composer", async () => {
    render(<ReplyForm ticketId={TICKET_ID} />);
    // Radix renders its options only while the listbox is OPEN, and as
    // `role="option"` rather than `<option>` — so the list has to be opened to
    // be read at all. Asserted on the visible LABELS, which is what an
    // operator actually chooses from; the property under test is that
    // "closed" is not among them.
    await userEvent.click(screen.getByLabelText("Status on send"));
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(labels).toEqual(["Just send", "Mark in progress on send", "Mark resolved on send"]);
  });
});
