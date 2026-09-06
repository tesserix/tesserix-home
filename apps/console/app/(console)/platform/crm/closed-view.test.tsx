import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FilterDescriptor } from "@/components/kit/filter-bar";
import { ClosedView } from "./closed-view";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm",
  // The counterpart of `queue-view.test.tsx`'s mock, and the reason #567
  // exists: the operator paged the two work queues, switched to Closed —
  // `tabHref` carrying `dueCursor`/`driftCursor` across with everything else
  // — paged that too, and is now changing a filter from THIS tab. All three
  // cursors are live in the URL and all three must go.
  useSearchParams: () =>
    new URLSearchParams("dueCursor=due-3&driftCursor=drift-7&closedCursor=closed-2&owner=Asha"),
}));

const DESCRIPTORS: FilterDescriptor[] = [
  { key: "owner", label: "Owner", type: "search" },
  {
    key: "product",
    label: "Product",
    type: "select",
    options: [{ value: "mark8ly", label: "Mark8ly" }],
  },
];

beforeEach(() => {
  replace.mockReset();
});

function view(overrides: Partial<Parameters<typeof ClosedView>[0]> = {}) {
  return (
    <ClosedView
      descriptors={DESCRIPTORS}
      values={{ owner: "Asha" }}
      items={[]}
      state={{ kind: "empty" }}
      emptyMessage="Nothing closed."
      total={0}
      precedingCount={0}
      nextHref={null}
      previousHref={null}
      {...overrides}
    />
  );
}

/** The query of the single `router.replace` the interaction produced. */
function pushedParams(): URLSearchParams {
  expect(replace).toHaveBeenCalledTimes(1);
  const url = replace.mock.calls[0][0] as string;
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

describe("ClosedView cursor handling", () => {
  it("drops every list cursor when a filter is changed, without losing the new filter value", () => {
    render(view());

    // A select, not the search box: `FilterBar`'s search input holds a local
    // draft and only flushes on blur or Enter, so `fireEvent.change` alone
    // pushes nothing. `queue-view.test.tsx` drives its select for the same
    // reason.
    fireEvent.click(screen.getByLabelText("Product"));
    fireEvent.click(screen.getByRole("option", { name: "Mark8ly" }));

    const params = pushedParams();
    expect(params.get("product")).toBe("mark8ly");
    expect(params.has("closedCursor")).toBe(false);
    // The queue tab's cursors too. Before #567 these survived, so switching
    // back to Work resumed a queue at a keyset position the narrowed filter
    // never produced — a filtered-empty page, indistinguishable on screen
    // from "nothing matches".
    expect(params.has("dueCursor")).toBe(false);
    expect(params.has("driftCursor")).toBe(false);
  });

  it("drops every list cursor when filters are cleared", () => {
    render(view());

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));

    expect(replace).toHaveBeenCalledTimes(1);
    const nextUrl = replace.mock.calls[0][0] as string;
    expect(nextUrl).not.toContain("closedCursor");
    expect(nextUrl).not.toContain("dueCursor");
    expect(nextUrl).not.toContain("driftCursor");
  });
});
