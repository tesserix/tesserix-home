import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchOnboardingFunnel = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchOnboardingFunnel: (...args: unknown[]) => fetchOnboardingFunnel(...args),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { OnboardingFunnel } from "@/lib/onboarding-funnel";
import OnboardingFunnelPage, {
  FUNNEL_SOURCE,
  ONBOARDING_UNAVAILABLE_TITLE,
  funnelState,
  onboardingReadError,
} from "./page";

const FUNNEL: OnboardingFunnel = {
  stages: [
    { stage: "started", count: 120 },
    { stage: "completed", count: 40 },
  ],
  medianCompletionSeconds: null,
  last24h: { started: 7, completed: 2 },
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-30T00:00:00Z" },
};

const ZEROED: OnboardingFunnel = {
  ...FUNNEL,
  stages: [
    { stage: "started", count: 0 },
    { stage: "completed", count: 0 },
  ],
  last24h: { started: 0, completed: 0 },
};

describe("funnelState", () => {
  it("is ready for a funnel of zeroes — that is a measurement", () => {
    expect(funnelState({ error: null, funnel: ZEROED }).kind).toBe("ready");
  });

  it("is instrumentation-unavailable for a 501, not an error", () => {
    // The state this deployment is actually in: platform-api answers 501
    // until FEDERATION_MARK8LY_ENDPOINTS includes `onboarding`.
    const state = funnelState({
      error: new PlatformApiError("no product declares an onboarding funnel", 501),
      funnel: null,
    });
    expect(state.kind).toBe("instrumentation-unavailable");
    expect(state.kind === "instrumentation-unavailable" && state.title).toBe(
      ONBOARDING_UNAVAILABLE_TITLE,
    );
  });

  it("is an error for a funnel that could not be read", () => {
    // 503 — the product was unreachable, or answered with something
    // platform-api refused to call a funnel. Never an empty funnel.
    expect(
      funnelState({
        error: new PlatformApiError("the funnel could not be read", 503),
        funnel: null,
      }).kind,
    ).toBe("error");
  });

  it("is never ready without a funnel to be ready about", () => {
    expect(funnelState({ error: null, funnel: null }).kind).not.toBe("ready");
  });
});

describe("onboardingReadError", () => {
  it("names the surface in the parked copy rather than reusing the generic park text", () => {
    const error = onboardingReadError(new PlatformApiError("nope", 501));
    expect(error?.unavailable?.message).toContain("onboarding");
  });

  it("leaves a genuine failure's status alone", () => {
    expect(onboardingReadError(new PlatformApiError("boom", 503))?.unavailable).toBeUndefined();
  });
});

describe("OnboardingFunnelPage", () => {
  it("asks the platform API for the product that implements the funnel", async () => {
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await OnboardingFunnelPage());
    expect(fetchOnboardingFunnel).toHaveBeenCalledWith(FUNNEL_SOURCE);
  });

  it("renders the product's stages when the funnel was read", async () => {
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await OnboardingFunnelPage());
    expect(screen.getAllByTestId("funnel-stage")).toHaveLength(2);
  });

  it("renders a 501 as a parked federation, not as an empty funnel", async () => {
    // The state a reviewer will actually see on deploy. It must not look like
    // "nobody signed up", and it must not look like a broken page either.
    fetchOnboardingFunnel.mockRejectedValue(
      new PlatformApiError("no product declares an onboarding funnel", 501),
    );
    render(await OnboardingFunnelPage());
    expect(screen.getByText(ONBOARDING_UNAVAILABLE_TITLE)).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
    expect(screen.queryByTestId("funnel-pulse")).toBeNull();
  });

  it("names the product it could not read when the read fails", async () => {
    fetchOnboardingFunnel.mockRejectedValue(new PlatformApiError("upstream down", 503));
    render(await OnboardingFunnelPage());
    expect(screen.getByText(new RegExp(FUNNEL_SOURCE))).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
  });
});
