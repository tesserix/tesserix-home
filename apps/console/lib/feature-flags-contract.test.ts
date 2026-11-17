import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/feature-flags.json";
import commands from "./__fixtures__/feature-flag-commands.json";
import {
  parseFeatureFlagSnapshot,
  featureFlagCommandsSchema,
} from "./feature-flags-contract";

describe("the feature flag API owner wire contract", () => {
  it("preserves release state, prerequisites and authoritative impact", () => {
    const data = parseFeatureFlagSnapshot(fixture);
    expect(data.flags[0]?.impact_when_disabled).toEqual(["staff_core"]);
    expect(data.flags[1]?.available).toBe(true);
    expect(data.flags[1]?.dependencies).toEqual(["team_accounts"]);
    expect(featureFlagCommandsSchema.parse(commands)[0]?.state).toBe(
      "in_doubt",
    );
  });
  it("refuses incomplete, cross-product and contradictory states", () => {
    expect(() =>
      parseFeatureFlagSnapshot({ ...fixture, product: "other" }),
    ).toThrow();
    expect(() =>
      parseFeatureFlagSnapshot({
        ...fixture,
        flags: [{ ...fixture.flags[0], eligible: false, available: true }],
      }),
    ).toThrow();
    expect(() =>
      parseFeatureFlagSnapshot({
        ...fixture,
        flags: [fixture.flags[0], fixture.flags[0]],
      }),
    ).toThrow();
  });
});
