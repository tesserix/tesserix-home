import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api-error";
import { parseOnboardingFunnel } from "./onboarding-funnel";

// mark8ly's actual wire shape (`platformadmin/onboarding.go`'s `funnelRow`):
// five counters flattened onto the root, a nullable median, a `last_24h`
// carrying ONLY started/completed, and the effective window.
const FUNNEL = {
  started: 120,
  email_verified: 90,
  completed: 40,
  in_flight: 15,
  abandoned: 65,
  median_completion_seconds: 842.5,
  last_24h: { started: 7, completed: 2 },
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-30T00:00:00Z" },
};

describe("parseOnboardingFunnel", () => {
  it("keeps mark8ly's stage vocabulary verbatim, in the order it was sent", () => {
    expect(parseOnboardingFunnel(FUNNEL).stages).toEqual([
      { stage: "started", count: 120 },
      { stage: "email_verified", count: 90 },
      { stage: "completed", count: 40 },
      { stage: "in_flight", count: 15 },
      { stage: "abandoned", count: 65 },
    ]);
  });

  it("carries through a stage this build has never heard of", () => {
    // The whole reason platform-api forwards the payload as raw bytes: a
    // console-side enumeration would drop the new stage on the floor and the
    // funnel would quietly stop adding up.
    const stages = parseOnboardingFunnel({ ...FUNNEL, payment_added: 12 }).stages;
    expect(stages.map((s) => s.stage)).toContain("payment_added");
  });

  it("keeps a zero stage as a measurement rather than dropping it", () => {
    const stages = parseOnboardingFunnel({ ...FUNNEL, completed: 0 }).stages;
    expect(stages).toContainEqual({ stage: "completed", count: 0 });
  });

  it("reads a null median as null, never as zero", () => {
    expect(
      parseOnboardingFunnel({ ...FUNNEL, median_completion_seconds: null })
        .medianCompletionSeconds,
    ).toBeNull();
  });

  it("refuses a funnel with no median key at all", () => {
    const { median_completion_seconds: _omitted, ...withoutMedian } = FUNNEL;
    expect(() => parseOnboardingFunnel(withoutMedian)).toThrow(PlatformApiError);
  });

  it("refuses a funnel carrying no stage counters", () => {
    // A funnel with nothing but structure renders identically to a funnel of
    // zeroes, which is the one thing this surface may never do.
    expect(() =>
      parseOnboardingFunnel({
        median_completion_seconds: null,
        last_24h: { started: 0, completed: 0 },
        window: FUNNEL.window,
      }),
    ).toThrow(PlatformApiError);
  });

  it("reads only started and completed from the live pulse", () => {
    // mark8ly's `last24hRow` is deliberately narrower than its counter row —
    // the contract pins two keys there, and inventing three more would print
    // phantom zeroes.
    expect(parseOnboardingFunnel(FUNNEL).last24h).toEqual({ started: 7, completed: 2 });
  });

  it("reads the effective window mark8ly echoed back", () => {
    expect(parseOnboardingFunnel(FUNNEL).window).toEqual({
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-30T00:00:00Z",
    });
  });

  it("refuses a stage whose count is not a whole number", () => {
    expect(() => parseOnboardingFunnel({ ...FUNNEL, started: 1.5 })).toThrow(PlatformApiError);
  });

  it("refuses a response that is not an object", () => {
    expect(() => parseOnboardingFunnel(null)).toThrow(PlatformApiError);
  });
});
