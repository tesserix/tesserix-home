import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUrlFilters, type FilterDescriptor } from "./filter-bar";

const replace = vi.fn();
let query = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm",
  useSearchParams: () => new URLSearchParams(query),
}));

const DESCRIPTORS: FilterDescriptor[] = [
  { key: "owner", label: "Owner", type: "search" },
  { key: "stage", label: "Stage", type: "search" },
];

beforeEach(() => {
  replace.mockReset();
});

/** A probe rendering nothing but the hook's mutations, so these tests
 *  describe the hook rather than any one surface's filter widgets. */
function Probe({ dropOnChange }: { dropOnChange?: readonly string[] }) {
  const { set, clear } = useUrlFilters(DESCRIPTORS, dropOnChange);
  return (
    <>
      <button type="button" onClick={() => set("owner", "Asha")}>
        set owner
      </button>
      <button type="button" onClick={() => set("stage", "new")}>
        set stage
      </button>
      <button type="button" onClick={clear}>
        clear
      </button>
    </>
  );
}

function pushedQuery(call = 0): URLSearchParams {
  const [url] = replace.mock.calls[call] as [string];
  return new URLSearchParams(url.split("?")[1] ?? "");
}

describe("useUrlFilters", () => {
  it("leaves the query alone when no params are named for dropping", () => {
    // The two other callers (tickets, audit log) page by `?page=`, which
    // `mergeFiltersIntoQuery` already clears; nothing about them changes.
    query = "owner=Priya&cursor=abc";
    render(<Probe />);
    fireEvent.click(screen.getByText("set owner"));
    expect(pushedQuery().get("cursor")).toBe("abc");
    expect(pushedQuery().get("owner")).toBe("Asha");
  });

  it("drops one named param on a filter change", () => {
    // The browse surface: a filter change while on page 3 must not land the
    // operator on an empty page 3 of a now-shorter list, which reads as "no
    // results" rather than "you are past the end".
    query = "owner=Priya&cursor=abc";
    render(<Probe dropOnChange={["cursor"]} />);
    fireEvent.click(screen.getByText("set owner"));
    expect(pushedQuery().has("cursor")).toBe(false);
    expect(pushedQuery().get("owner")).toBe("Asha");
  });

  it("drops every named param, not just the first", () => {
    // The CRM queues: one filter bar drives both, so a narrowed filter
    // invalidates both positions at once. This is the only thing that
    // differed between the two hand-written copies this replaced.
    query = "dueCursor=due-3&driftCursor=drift-7&owner=Priya";
    render(<Probe dropOnChange={["dueCursor", "driftCursor"]} />);
    fireEvent.click(screen.getByText("set owner"));
    expect(pushedQuery().has("dueCursor")).toBe(false);
    expect(pushedQuery().has("driftCursor")).toBe(false);
    expect(pushedQuery().get("owner")).toBe("Asha");
  });

  it("drops them on a clear as well as on a set", () => {
    query = "dueCursor=due-3&driftCursor=drift-7&owner=Priya";
    render(<Probe dropOnChange={["dueCursor", "driftCursor"]} />);
    fireEvent.click(screen.getByText("clear"));
    expect(replace).toHaveBeenCalledWith("/platform/crm");
  });

  it("keeps the drop inside the same push, so two changes in a tick cannot lose one", () => {
    // `router.replace` is asynchronous: `useSearchParams` still reports the
    // old query for the rest of the tick. A separate cursor-clearing
    // navigation could overwrite a filter change that raced it.
    query = "cursor=abc";
    render(<Probe dropOnChange={["cursor"]} />);
    fireEvent.click(screen.getByText("set owner"));
    fireEvent.click(screen.getByText("set stage"));
    expect(replace).toHaveBeenCalledTimes(2);
    const second = pushedQuery(1);
    expect(second.get("owner")).toBe("Asha");
    expect(second.get("stage")).toBe("new");
    expect(second.has("cursor")).toBe(false);
  });
});
