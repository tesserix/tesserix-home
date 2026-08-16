import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueueList, type QueueItem } from "./queue-list";

// A queue row carries two orthogonal signals: how loudly the item is shouting
// (`severity`, derived from priority) and where it sits in its own workflow
// (`status`). They are separate badges because an urgent ticket already in
// progress reads nothing like an urgent one nobody has touched.

const ITEM: QueueItem = {
  key: "mark8ly#412",
  title: "Cannot log in after password reset",
  subtitle: "Asha Rao · asha@example.com",
  product: "mark8ly",
  waitingSince: "2026-08-16T09:00:00.000Z",
  severity: "normal",
  href: "/platform/tickets/2f6c",
};

function renderRow(overrides: Partial<QueueItem> = {}) {
  render(
    <QueueList
      items={[{ ...ITEM, ...overrides }]}
      state={{ kind: "ready" }}
      emptyMessage="Nothing waiting."
      now={Date.parse("2026-08-16T12:00:00.000Z")}
    />,
  );
  // The badge row is the link's parent, so it can be reached without adding
  // markup that exists only for tests.
  const link = screen.getByRole("link", { name: ITEM.title });
  return { link, badgeRow: link.parentElement as HTMLElement };
}

describe("QueueList status slot", () => {
  it("renders the status beside the product badge, without displacing severity", () => {
    const { badgeRow } = renderRow({ status: { label: "In progress", tone: "info" } });

    expect(screen.getByText("mark8ly")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    // Severity is untouched by the new slot — still derived, still rendered.
    expect(screen.getByText("normal")).toBeInTheDocument();

    // Link + product + status + severity, in that order.
    expect(badgeRow.children).toHaveLength(4);
    expect(badgeRow.children[1]).toHaveTextContent("mark8ly");
    expect(badgeRow.children[2]).toHaveTextContent("In progress");
    expect(badgeRow.children[3]).toHaveTextContent("normal");
  });

  it("renders a row without a status exactly as it did before the slot existed", () => {
    // Guards the optionality: the slot must add nothing at all when omitted,
    // or every pre-existing caller silently grows an empty element.
    const { badgeRow } = renderRow();

    expect(badgeRow.children).toHaveLength(3);
    expect(badgeRow.children[1]).toHaveTextContent("mark8ly");
    expect(badgeRow.children[2]).toHaveTextContent("normal");
    expect(screen.queryByText("In progress")).toBeNull();
  });

  it("defaults an untoned status to neutral rather than dropping it", () => {
    renderRow({ status: { label: "Waiting on customer" } });
    expect(screen.getByText("Waiting on customer")).toBeInTheDocument();
  });

  it("keeps status and severity as separate elements, not one merged badge", () => {
    const { badgeRow } = renderRow({
      // The interesting case: an urgent item that someone is already on.
      severity: "critical",
      status: { label: "In progress", tone: "info" },
    });

    const status = screen.getByText("In progress");
    const severity = screen.getByText("critical");
    expect(status).not.toBe(severity);
    expect(status).not.toContainElement(severity);
    expect(badgeRow.children).toHaveLength(4);
  });
});
