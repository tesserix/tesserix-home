import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tools-write", () => ({
  createTool: vi.fn(), updateTool: vi.fn(), deleteTool: vi.fn(),
  createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { createTool, deleteTool, updateGroup, updateTool } from "@/lib/tools-write";
import { addToolAction, moveGroupAction, moveToolAction, removeToolAction } from "./actions";

afterEach(() => vi.resetAllMocks());

const TOOL = {
  name: "Tempo", subdomain: "tempo", purpose: "Traces.",
  note: null, groupKey: "observability",
};

describe("the tools management actions", () => {
  it("revalidates BOTH the management page and the home page after a write", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: true });

    await addToolAction(TOOL);

    const paths = vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
    // The home page renders the same directory. Revalidating only this page
    // leaves the cards stale until something else evicts them, which reads as
    // "the edit did not work".
    expect(paths).toContain("/platform/tools");
    expect(paths).toContain("/");
  });

  it("does NOT revalidate when the write failed", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: false, message: "nope" });

    const result = await addToolAction(TOOL);

    expect(result).toEqual({ ok: false, message: "nope" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the seam's field through so a form can place the message", async () => {
    vi.mocked(createTool).mockResolvedValue({ ok: false, message: "bad", field: "subdomain" });

    const result = await addToolAction({ ...TOOL, subdomain: "!!" });

    expect(result).toEqual({ ok: false, message: "bad", field: "subdomain" });
  });

  it("swaps two tools' STORED sort orders, in two calls", async () => {
    vi.mocked(updateTool).mockResolvedValue({ ok: true });

    await moveToolAction({ id: "a", sortOrder: 10 }, { id: "b", sortOrder: 20 });

    // The real stored values, not render indices — see Task 6. Asserting BOTH
    // legs with swapped values is what stops a half-move shipping unnoticed.
    expect(updateTool).toHaveBeenCalledWith("a", { sortOrder: 20 });
    expect(updateTool).toHaveBeenCalledWith("b", { sortOrder: 10 });
  });

  it("reports the second leg's failure but STILL revalidates, because the first leg's write landed", async () => {
    vi.mocked(updateTool)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: "second leg failed" });

    const result = await moveToolAction({ id: "a", sortOrder: 10 }, { id: "b", sortOrder: 20 });

    expect(result).toEqual({ ok: false, message: "second leg failed" });
    // Leg 1 (mocked `{ ok: true }` above) already wrote to the database, so the
    // cache MUST be evicted even though the overall action reports failure —
    // otherwise the operator sees an error next to a list that silently
    // disagrees with what the API now holds.
    const paths = vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
    expect(paths).toContain("/platform/tools");
    expect(paths).toContain("/");
  });

  it("removes a tool and revalidates", async () => {
    vi.mocked(deleteTool).mockResolvedValue({ ok: true });

    const result = await removeToolAction("tool-1");

    expect(result).toEqual({ ok: true });
    expect(deleteTool).toHaveBeenCalledWith("tool-1");

    const paths = vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
    // Parity with the first test: asserting only "called" would still pass if
    // refresh() were gutted to revalidate just this page, leaving the home
    // page's cards stale.
    expect(paths).toContain("/platform/tools");
    expect(paths).toContain("/");
  });

  it("swaps two groups' STORED sort orders, in two calls", async () => {
    vi.mocked(updateGroup).mockResolvedValue({ ok: true });

    await moveGroupAction({ key: "identity", sortOrder: 5 }, { key: "cost", sortOrder: 15 });

    expect(updateGroup).toHaveBeenCalledWith("identity", { sortOrder: 15 });
    expect(updateGroup).toHaveBeenCalledWith("cost", { sortOrder: 5 });
  });
});
