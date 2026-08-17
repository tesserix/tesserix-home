import { describe, expect, it } from "vitest";
import { CRM_STAGES, isCrmStage } from "./crm";

describe("crm vocabulary", () => {
  it("lists the five stages in pipeline order", () => {
    expect([...CRM_STAGES]).toEqual([
      "new", "contacted", "qualified", "won", "lost",
    ]);
  });

  it("rejects a stage that is not in the set", () => {
    // Guards the guard: a predicate returning true for everything would pass
    // every other assertion in this file.
    expect(isCrmStage("won")).toBe(true);
    expect(isCrmStage("converted")).toBe(false);
  });
});
