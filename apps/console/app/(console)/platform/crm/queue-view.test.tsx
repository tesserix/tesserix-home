import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FilterDescriptor } from "@/components/kit/filter-bar";
import { CrmQueueView, type CrmQueueGroupProps } from "./queue-view";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm",
  // Both queues already paged, as if the operator worked their way down each
  // one before touching a filter. Changing a filter must drop BOTH cursors:
  // one filter bar narrows both result sets at once, so either survivor
  // resumes a queue from a position its new result set may not have.
  useSearchParams: () => new URLSearchParams("dueCursor=due-3&driftCursor=drift-7&owner=Asha"),
}));

const DESCRIPTORS: FilterDescriptor[] = [
  { key: "owner", label: "Owner", type: "search" },
  {
    key: "stage",
    label: "Stage",
    type: "select",
    options: [{ value: "new", label: "New" }],
  },
];

beforeEach(() => {
  replace.mockReset();
});

function group(overrides: Partial<CrmQueueGroupProps> = {}): CrmQueueGroupProps {
  return {
    heading: "Due",
    pagerLabel: "the due queue",
    items: [],
    state: { kind: "empty" },
    emptyMessage: "Nothing due.",
    total: 0,
    precedingCount: 0,
    nextHref: null,
    ...overrides,
  };
}

function renderView(
  due: CrmQueueGroupProps = group(),
  drifting: CrmQueueGroupProps = group({ heading: "Drifting", pagerLabel: "the drifting queue" }),
) {
  render(
    <CrmQueueView
      descriptors={DESCRIPTORS}
      values={{ owner: "Asha" }}
      due={due}
      drifting={drifting}
    />,
  );
}

const READY_GROUP: Partial<CrmQueueGroupProps> = {
  state: { kind: "ready" },
  items: [
    {
      key: "opp-1",
      title: "Bondi Store",
      product: "Mark8ly",
      waitingSince: "2026-07-01T09:00:00.000Z",
      severity: "normal",
      status: { label: "New", tone: "neutral" },
      href: "/platform/crm/org-1",
    },
  ],
};

describe("CrmQueueView filter changes", () => {
  it("drops both queue cursors when a filter is changed, without losing the new filter value", () => {
    renderView();

    fireEvent.click(screen.getByLabelText("Stage"));
    fireEvent.click(screen.getByRole("option", { name: "New" }));

    expect(replace).toHaveBeenCalledOnce();
    const [nextUrl] = replace.mock.calls[0] as [string];
    const params = new URLSearchParams(nextUrl.split("?")[1]);

    expect(params.get("stage")).toBe("new");
    expect(params.has("dueCursor")).toBe(false);
    expect(params.has("driftCursor")).toBe(false);
  });

  it("drops both queue cursors when filters are cleared", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));

    expect(replace).toHaveBeenCalledOnce();
    const [nextUrl] = replace.mock.calls[0] as [string];
    expect(nextUrl).not.toContain("dueCursor");
    expect(nextUrl).not.toContain("driftCursor");
  });
});

describe("CrmQueueView pagers", () => {
  it("puts each queue's pager inside that queue's own section", () => {
    renderView(
      group({ ...READY_GROUP, total: 259, nextHref: "/platform/crm?dueCursor=due-4" }),
      group({
        ...READY_GROUP,
        heading: "Drifting",
        pagerLabel: "the drifting queue",
        total: 12,
        nextHref: null,
      }),
    );

    // Each pager is a descendant of the section headed by its own queue, so
    // which "Next" belongs to which queue is structural, not a matter of
    // which heading happens to sit nearest on screen.
    const dueSection = screen.getByRole("heading", { name: "Due" }).closest("section");
    expect(dueSection).toContainElement(
      screen.getByRole("navigation", { name: "the due queue pagination" }),
    );

    const driftingSection = screen.getByRole("heading", { name: "Drifting" }).closest("section");
    expect(driftingSection).toContainElement(
      screen.getByRole("navigation", { name: "the drifting queue pagination" }),
    );
  });

  it("renders the empty message and no pager for an empty queue", () => {
    renderView();

    expect(screen.getAllByText("Nothing due.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation", { name: /pagination/ })).toBeNull();
  });

  it("renders no pager for a queue whose read failed", () => {
    renderView(group({ state: { kind: "error", message: "Could not load the Due queue." } }));

    expect(screen.queryByRole("navigation", { name: "the due queue pagination" })).toBeNull();
  });
});
