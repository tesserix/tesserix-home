import { describe, expect, it } from "vitest";
import { CRM_STAGES, isCrmStage, isCrmActivityKind, isHumanActivityKind } from "./crm";

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

describe("isHumanActivityKind", () => {
  it("accepts every kind an operator can author directly", () => {
    for (const kind of ["note", "dm_sent", "dm_received", "email_sent", "email_received", "call"]) {
      expect(isHumanActivityKind(kind)).toBe(true);
    }
  });

  // The point of this predicate: `stage_change` and `assigned` are valid
  // `CrmActivityKind`s (isCrmActivityKind accepts them) but system-authored
  // ones, so an operator-facing "log an activity" action must reject them
  // even though the broader kind check would let them through.
  it("rejects the system-authored kinds even though isCrmActivityKind accepts them", () => {
    expect(isCrmActivityKind("stage_change")).toBe(true);
    expect(isCrmActivityKind("assigned")).toBe(true);
    expect(isHumanActivityKind("stage_change")).toBe(false);
    expect(isHumanActivityKind("assigned")).toBe(false);
  });

  it("rejects a value that is not an activity kind at all", () => {
    expect(isHumanActivityKind("carrier_pigeon")).toBe(false);
  });
});
