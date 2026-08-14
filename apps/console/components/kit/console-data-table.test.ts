import { describe, expect, it } from "vitest";
import { runBulkAction } from "./console-data-table";

// A bulk action that rejects must not become an unhandled promise rejection.
// The operator would see the bar re-enable with the selection intact and no
// indication of whether the work happened — dangerous on a destructive action.

describe("runBulkAction", () => {
  it("reports success and passes the selected ids through", async () => {
    const seen: string[][] = [];
    const outcome = await runBulkAction(
      { run: async (ids) => void seen.push(ids) },
      ["run-1:gate-a", "run-2:gate-b"],
    );

    expect(outcome).toEqual({ ok: true });
    expect(seen).toEqual([["run-1:gate-a", "run-2:gate-b"]]);
  });

  it("captures a rejection as a value instead of letting it escape", async () => {
    const outcome = await runBulkAction(
      { run: async () => { throw new Error("approval service returned 503"); } },
      ["run-1:gate-a"],
    );

    expect(outcome).toEqual({ ok: false, message: "approval service returned 503" });
  });

  it("still surfaces a message when the rejection carries none", async () => {
    const outcome = await runBulkAction(
      { run: async () => { throw new Error(""); } },
      ["run-1:gate-a"],
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message.length).toBeGreaterThan(0);
  });

  it("surfaces a non-Error rejection rather than rendering undefined", async () => {
    const outcome = await runBulkAction(
      { run: async () => { throw "just a string"; } },
      ["run-1:gate-a"],
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message.length).toBeGreaterThan(0);
  });
});
