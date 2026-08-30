import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchOnboardingFunnel = vi.fn();
const fetchPlatformSources = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchOnboardingFunnel: (...args: unknown[]) => fetchOnboardingFunnel(...args),
  fetchPlatformSources: (...args: unknown[]) => fetchPlatformSources(...args),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { PlatformSources } from "@/lib/platform-sources";
import type { OnboardingFunnel } from "@/lib/onboarding-funnel";
import {
  ONBOARDING_UNAVAILABLE_TITLE,
  SOURCES_UNREADABLE_MESSAGE,
} from "./source-choice";
import OnboardingFunnelPage, {
  onboardingPageState,
  onboardingReadError,
  sessionsLink,
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

/** The estate as it is deployed today: one product declares `onboarding`. */
const SOURCES: PlatformSources = {
  endpoints: { onboarding: ["mark8ly"], outbox: ["mark8ly"] },
  entities: { tenants: ["mark8ly"], users: ["kora"] },
};

const TWO_SOURCES: PlatformSources = {
  ...SOURCES,
  endpoints: { onboarding: ["kora", "mark8ly"] },
};

/** No product declares onboarding — a successful read of an estate that
 *  federates none, which is NOT the same as a read that failed. */
const NO_SOURCES: PlatformSources = { endpoints: {}, entities: {} };

function ready(choice: { source: string }, funnel: OnboardingFunnel | null) {
  return onboardingPageState({
    sourcesError: null,
    choice: { kind: "source", ...choice },
    funnelError: null,
    funnel,
  });
}

describe("onboardingPageState", () => {
  it("is ready for a funnel of zeroes — that is a measurement", () => {
    expect(ready({ source: "mark8ly" }, ZEROED).kind).toBe("ready");
  });

  it("is instrumentation-unavailable for a 501, not an error", () => {
    const state = onboardingPageState({
      sourcesError: null,
      choice: { kind: "source", source: "mark8ly" },
      funnelError: new PlatformApiError("no product declares an onboarding funnel", 501),
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
      onboardingPageState({
        sourcesError: null,
        choice: { kind: "source", source: "mark8ly" },
        funnelError: new PlatformApiError("the funnel could not be read", 503),
        funnel: null,
      }).kind,
    ).toBe("error");
  });

  it("is never ready without a funnel to be ready about", () => {
    expect(ready({ source: "mark8ly" }, null).kind).not.toBe("ready");
  });

  it("says the DECLARATIONS could not be read, and names no product", () => {
    // The failure this whole change exists to make visible. A page that fell
    // back to mark8ly here would look identical to a working one.
    const state = onboardingPageState({
      sourcesError: new PlatformApiError("sources: unreachable", 503),
      choice: null,
      funnelError: null,
      funnel: null,
    });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.message).toBe(SOURCES_UNREADABLE_MESSAGE);
    expect(state.kind === "error" && state.message).not.toContain("mark8ly");
  });

  it("keeps a tokenless session's sign-in prompt when the sources read is the one that failed", () => {
    // Both reads fail for this session. Replacing the message must not cost
    // the one state that has a ten-second remedy attached.
    const state = onboardingPageState({
      sourcesError: new PlatformApiError("no token", undefined, { noOperatorToken: true }),
      choice: null,
      funnelError: null,
      funnel: null,
    });
    expect(state.kind).toBe("reauth-required");
  });

  it("renders an estate that declares nothing as parked, not as an error", () => {
    // The successful read of an empty declaration list is the same fact
    // platform-api reports as a 501, so it gets the same calm copy.
    const state = onboardingPageState({
      sourcesError: null,
      choice: { kind: "none-declared" },
      funnelError: null,
      funnel: null,
    });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("refuses a source nobody declares rather than answering about another one", () => {
    const state = onboardingPageState({
      sourcesError: null,
      choice: { kind: "unknown-source", requested: "shopify", declared: ["mark8ly"] },
      funnelError: null,
      funnel: null,
    });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.message).toContain("shopify");
    expect(state.kind === "error" && state.message).toContain("mark8ly");
  });
});

describe("onboardingReadError", () => {
  it("names the surface in the parked copy rather than reusing the generic park text", () => {
    const error = onboardingReadError(new PlatformApiError("nope", 501), "mark8ly");
    expect(error?.unavailable?.message).toContain("onboarding");
  });

  it("leaves a genuine failure's status alone", () => {
    expect(
      onboardingReadError(new PlatformApiError("boom", 503), "mark8ly")?.unavailable,
    ).toBeUndefined();
  });
});

describe("sessionsLink", () => {
  it("carries the chosen source across so both surfaces describe one product", () => {
    expect(sessionsLink({ kind: "source", source: "mark8ly" })).toBe(
      "/platform/onboarding/sessions?source=mark8ly",
    );
  });

  it("goes bare when no product was chosen rather than inventing one", () => {
    expect(sessionsLink(null)).toBe("/platform/onboarding/sessions");
    expect(sessionsLink({ kind: "none-declared" })).toBe("/platform/onboarding/sessions");
  });
});

describe("OnboardingFunnelPage", () => {
  // Vitest here runs without automatic mock resetting, and several of these
  // tests assert that a read was NOT made — which a call left over from the
  // previous test would silently satisfy in the wrong direction.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPage(params: Record<string, string | string[]> = {}) {
    return OnboardingFunnelPage({ searchParams: Promise.resolve(params) });
  }

  it("asks the product the DEPLOYMENT declares, not a hardcoded one", async () => {
    // Asserted against the declaration the API returned, not against the
    // literal that used to live in this file: the mock returns `kora` first
    // precisely so a reintroduced `mark8ly` default would fail here.
    fetchPlatformSources.mockResolvedValue(TWO_SOURCES);
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage());
    expect(fetchOnboardingFunnel).toHaveBeenCalledWith("kora");
  });

  it("asks for the source the URL names when that product declares onboarding", async () => {
    fetchPlatformSources.mockResolvedValue(TWO_SOURCES);
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage({ source: "mark8ly" }));
    expect(fetchOnboardingFunnel).toHaveBeenCalledWith("mark8ly");
  });

  it("renders the product's stages when the funnel was read", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage());
    expect(screen.getAllByTestId("funnel-stage")).toHaveLength(2);
  });

  it("renders no chips for the one product declaring onboarding today", async () => {
    // One chip is a control that cannot be operated. The list still came from
    // the declaration — the next test is the same read with two products.
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage());
    expect(screen.queryAllByTestId("funnel-source")).toHaveLength(0);
  });

  it("renders a chip per declared product once there is a choice to make", async () => {
    fetchPlatformSources.mockResolvedValue(TWO_SOURCES);
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage({ source: "mark8ly" }));
    const chips = screen.getAllByTestId("funnel-source");
    expect(chips.map((chip) => chip.textContent)).toEqual(["kora", "mark8ly"]);
    expect(chips.find((chip) => chip.dataset.selected === "true")?.textContent).toBe("mark8ly");
  });

  it("renders a 501 as a parked federation, not as an empty funnel", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingFunnel.mockRejectedValue(
      new PlatformApiError("no product declares an onboarding funnel", 501),
    );
    render(await renderPage());
    expect(screen.getByText(ONBOARDING_UNAVAILABLE_TITLE)).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
    expect(screen.queryByTestId("funnel-pulse")).toBeNull();
  });

  it("names the product it could not read when the read fails", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingFunnel.mockRejectedValue(new PlatformApiError("upstream down", 503));
    render(await renderPage());
    expect(screen.getByText(/mark8ly/)).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
  });

  it("asks no product at all when the declarations could not be read", async () => {
    // The hardcode-in-disguise test. A fallback would show a funnel here.
    fetchPlatformSources.mockRejectedValue(new PlatformApiError("sources down", 503));
    fetchOnboardingFunnel.mockResolvedValue(FUNNEL);
    render(await renderPage());
    expect(fetchOnboardingFunnel).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
    expect(screen.getByText(SOURCES_UNREADABLE_MESSAGE)).toBeTruthy();
  });

  it("asks no product when the estate declares none, and says nothing is broken", async () => {
    fetchPlatformSources.mockResolvedValue(NO_SOURCES);
    render(await renderPage());
    expect(fetchOnboardingFunnel).not.toHaveBeenCalled();
    expect(screen.getByText(ONBOARDING_UNAVAILABLE_TITLE)).toBeTruthy();
  });

  it("asks nothing for a source nobody declares, rather than the API's 400", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    render(await renderPage({ source: "shopify" }));
    expect(fetchOnboardingFunnel).not.toHaveBeenCalled();
    expect(screen.getByText(/shopify/)).toBeTruthy();
  });

  it("links the sessions behind the counts even when the funnel could not be read", async () => {
    // A funnel that will not load is exactly when an operator wants the rows.
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingFunnel.mockRejectedValue(new PlatformApiError("upstream down", 503));
    render(await renderPage());
    const link = screen.getByRole("link", { name: /sessions behind these counts/i });
    expect(link.getAttribute("href")).toBe("/platform/onboarding/sessions?source=mark8ly");
  });
});
