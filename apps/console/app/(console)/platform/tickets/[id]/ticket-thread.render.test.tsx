// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketThread } from "./ticket-thread";
import type { TicketDetail } from "@/lib/tickets";

const DETAIL: TicketDetail = {
  ticket: {
    id: "5f0b2c34-0000-0000-0000-000000000000",
    productId: "mark8ly",
    tenantId: "",
    ticketNumber: "M8-1042",
    subject: "Payout missing",
    description: "The Friday payout never arrived.",
    status: "open",
    priority: "urgent",
    submittedByName: "Asha Pillai",
    submittedByEmail: "asha@example.com",
    resolvedAt: null,
    createdAt: "2026-08-10T04:00:00.000Z",
    updatedAt: "2026-08-11T04:00:00.000Z",
  },
  replies: [
    {
      id: "r1",
      authorType: "platform_admin",
      authorName: "Mahesh",
      authorEmail: "mahesh.sangawar@gmail.com",
      content: "Looking into it now.",
      createdAt: "2026-08-11T04:00:00.000Z",
    },
  ],
};

describe("TicketThread", () => {
  it("opens with the ticket description attributed to the submitter", () => {
    render(<TicketThread detail={DETAIL} />);
    expect(
      screen.getByText("The Friday payout never arrived."),
    ).toBeInTheDocument();
    expect(screen.getByText("Asha Pillai")).toBeInTheDocument();
  });

  it("labels operator replies as the platform's, not the customer's", () => {
    render(<TicketThread detail={DETAIL} />);
    expect(screen.getByText("Looking into it now.")).toBeInTheDocument();
    expect(screen.getByText(/platform/i)).toBeInTheDocument();
  });

  it("renders an empty thread as just the description", () => {
    render(<TicketThread detail={{ ...DETAIL, replies: [] }} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
