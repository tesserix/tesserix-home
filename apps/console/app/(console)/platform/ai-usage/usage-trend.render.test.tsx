import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AiUsagePoint } from "@/lib/ai-usage";
import { UsageTrend, bucketLabel } from "./usage-trend";

const TOKENS = { input: 1000, output: 250, cachedInput: 400 };

const POINT: AiUsagePoint = {
  bucket: "2026-08-19T22:00:00Z",
  requests: 400,
  tokens: TOKENS,
  costUsd: 0.002,
};

describe("bucketLabel", () => {
  it("labels an hourly bucket by its UTC hour", () => {
    // UTC, not the reader's timezone: the tables beside it are the gateway's
    // clock, and two clocks on one page pins an incident to the wrong hour.
    expect(bucketLabel("2026-08-19T22:00:00Z", 3600)).toBe("22:00");
  });

  it("labels a daily bucket by its date", () => {
    expect(bucketLabel("2026-08-19T00:00:00Z", 86_400)).toBe("19 Aug");
  });

  it("passes an unparseable bucket through rather than rendering NaN", () => {
    expect(bucketLabel("not a time", 3600)).toBe("not a time");
  });
});

describe("UsageTrend", () => {
  it("states each bucket's spend for a reader who cannot see the bars", () => {
    render(
      <UsageTrend
        points={[POINT]}
        bucketSeconds={3600}
        state={{ kind: "ready" }}
        emptyMessage="quiet"
      />,
    );
    expect(screen.getByText("22:00: $0.0020")).toBeInTheDocument();
  });

  it("draws a bucket that served requests at no measured cost", () => {
    // A free-but-busy hour rendering as nothing is indistinguishable from a
    // gap in the data, which is a different and more alarming thing.
    render(
      <UsageTrend
        points={[
          { ...POINT, costUsd: 1 },
          { ...POINT, bucket: "2026-08-19T23:00:00Z", costUsd: 0, requests: 12 },
        ]}
        bucketSeconds={3600}
        state={{ kind: "ready" }}
        emptyMessage="quiet"
      />,
    );
    const bars = document.querySelectorAll("li > span[aria-hidden='true']");
    expect(bars).toHaveLength(2);
    expect((bars[1] as HTMLElement).style.height).toBe("2%");
  });

  it("says the window is quiet instead of drawing an empty axis", () => {
    render(
      <UsageTrend points={[]} bucketSeconds={3600} state={{ kind: "empty" }} emptyMessage="quiet" />,
    );
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });
});
