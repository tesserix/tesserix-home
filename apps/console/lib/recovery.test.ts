import { describe, expect, it } from "vitest";
import { parseRecoveryStatus } from "./recovery";

describe("recovery metadata", () => {
  it("projects verified backup metadata and refuses malformed status", () => {
    const wire = {
      backups: [{ id: "20260927T055111Z-ae918f84b8d8", created: "2026-09-27T05:51:11Z", bytes: 200000, restoreSeconds: 19.884, openbaoVersion: "2.6.2", privateField: "must-not-escape" }],
      jobs: [], jobsComplete: true,
    };
    expect(parseRecoveryStatus(wire).backups[0].restoreSeconds).toBe(19.884);
    expect(JSON.stringify(parseRecoveryStatus(wire))).not.toContain("must-not-escape");
    expect(() => parseRecoveryStatus({ ...wire, backups: [...wire.backups, ...wire.backups, ...wire.backups, ...wire.backups] })).toThrow();
    expect(() => parseRecoveryStatus({ ...wire, jobsComplete: "yes" })).toThrow();
    expect(() => parseRecoveryStatus({ ...wire, backups: [{ ...wire.backups[0], restoreSeconds: -1 }] })).toThrow();
  });
});
