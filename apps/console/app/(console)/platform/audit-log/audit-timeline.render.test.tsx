import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourcedAuditEntry } from "@/lib/audit";
import { AuditTimeline, type AuditTimelineProps } from "./audit-timeline";
import { AUDIT_FILTERS, TIMELINE_EMPTY_MESSAGE, TIMELINE_SCOPE_NOTE } from "./page";

// `useUrlFilters` reads the router — same mock as page.test.tsx, needed
// because `AuditTimeline` calls it unconditionally.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/platform/audit-log",
  useSearchParams: () => new URLSearchParams(),
}));

const entryWithMetadata: SourcedAuditEntry = {
  id: "mark8ly:9f2",
  source: "mark8ly",
  actor: "ops@mark8ly.com",
  action: "tenant.suspend",
  target: "tenant:acme",
  timestamp: "2026-08-16T09:03:00.000Z",
  metadata: '{"tenant":"tenant-42"}',
};

const entryWithoutMetadata: SourcedAuditEntry = {
  id: "console:41",
  source: "console",
  actor: "sunita@tesserix.app",
  action: "identity.lookup",
  target: "sunita@example.com",
  timestamp: "2026-08-16T09:02:00.000Z",
};

const baseProps: Omit<AuditTimelineProps, "entries"> = {
  descriptors: AUDIT_FILTERS,
  values: {},
  state: { kind: "ready" },
  emptyMessage: TIMELINE_EMPTY_MESSAGE,
  notices: [],
  failures: [],
  scopeNote: TIMELINE_SCOPE_NOTE,
};

describe("AuditTimeline's disclosure", () => {
  it("hides an entry's metadata behind a disclosure rather than rendering it inline", async () => {
    // Before 2.2.0 the viewer had no disclosure slot, so metadata rendered
    // inline on every row and each entry's headline was pushed down by the
    // body of the one above it.
    render(<AuditTimeline {...baseProps} entries={[entryWithMetadata]} />);

    const disclosure = screen.getByRole("button", { name: /show details/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    // The metadata's rendered content must NOT be in the accessibility tree
    // while collapsed — a visually-hidden-but-present block is the bug this
    // change exists to fix, not a fix for it.
    expect(screen.queryByText(/tenant-42/)).toBeNull();

    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/tenant-42/)).toBeInTheDocument();
  });

  it("offers no disclosure for an entry that carries no metadata", () => {
    // An empty disclosure is a control that promises something and delivers
    // nothing; most console_audit_log rows carry no metadata at all.
    render(<AuditTimeline {...baseProps} entries={[entryWithoutMetadata]} />);
    expect(screen.queryByRole("button", { name: /show details/i })).toBeNull();
  });

  it("still renders the source badge for every entry", () => {
    // renderSource is unrelated to the disclosure and must survive the change:
    // attribution is why this surface stopped using a local re-implementation
    // of the viewer in the first place.
    render(<AuditTimeline {...baseProps} entries={[entryWithMetadata]} />);
    expect(screen.getByText("Mark8ly")).toBeInTheDocument();
  });
});
