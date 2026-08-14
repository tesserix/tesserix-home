import { describe, expect, it } from "vitest";
import { resolveState } from "./states";

describe("resolveState", () => {
  it("reports instrumentation-unavailable for a 501, not an error", () => {
    expect(resolveState({ isLoading: false, error: { status: 501 }, rows: [], filtered: false }))
      .toEqual({ kind: "instrumentation-unavailable" });
  });

  it("reports a transient failure as an error, not as uninstrumented", () => {
    // A network blip must never claim the product is uninstrumented.
    expect(resolveState({ isLoading: false, error: { status: 500, message: "boom" }, rows: [], filtered: false }))
      .toEqual({ kind: "error", message: "boom" });
  });

  it("distinguishes empty from filtered-empty", () => {
    expect(resolveState({ isLoading: false, error: null, rows: [], filtered: false })).toEqual({ kind: "empty" });
    expect(resolveState({ isLoading: false, error: null, rows: [], filtered: true })).toEqual({ kind: "filtered-empty" });
  });
});
