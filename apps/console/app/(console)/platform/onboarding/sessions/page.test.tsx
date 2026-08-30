import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchOnboardingSessions = vi.fn();
const fetchPlatformSources = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchOnboardingSessions: (...args: unknown[]) => fetchOnboardingSessions(...args),
  fetchPlatformSources: (...args: unknown[]) => fetchPlatformSources(...args),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/onboarding/sessions",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { OnboardingSession, OnboardingSessionList } from "@/lib/onboarding-sessions";
import type { PlatformSources } from "@/lib/platform-sources";
import { ONBOARDING_UNAVAILABLE_TITLE, SOURCES_UNREADABLE_MESSAGE } from "../source-choice";
import OnboardingSessionsPage, {
  isFiltered,
  readSessionFilters,
  sessionsPageState,
  sessionsReadError,
  withoutErrorCode,
} from "./page";

const SOURCES: PlatformSources = {
  endpoints: { onboarding: ["mark8ly"] },
  entities: {},
};

const ROW: OnboardingSession = {
  id: "sess-1",
  email: "merchant@example.com",
  status: "in_progress",
  createdAt: "2026-08-28T09:00:00Z",
  lastActivityAt: "2026-08-29T11:30:00Z",
  idleHours: 21.5,
  abandoned: false,
  completedAt: null,
  tenantId: null,
};

const PAGE: OnboardingSessionList = { rows: [ROW], total: 1, limit: 50 };
const EMPTY_PAGE: OnboardingSessionList = { rows: [], total: 0, limit: 50 };

describe("readSessionFilters", () => {
  it("reads the API's own parameter names off the URL", () => {
    expect(
      readSessionFilters({
        status: "in_progress",
        created_from: "2026-08-01T00:00:00Z",
        created_to: "2026-08-30T00:00:00Z",
        abandoned: "true",
      }),
    ).toEqual({
      status: "in_progress",
      createdFrom: "2026-08-01T00:00:00Z",
      createdTo: "2026-08-30T00:00:00Z",
      abandoned: "true",
    });
  });

  it("drops a blank value — a blank filter is no filter", () => {
    expect(readSessionFilters({ status: "  " }).status).toBeUndefined();
    expect(isFiltered(readSessionFilters({ status: "  " }))).toBe(false);
  });

  it("passes a status this build has never heard of through unvalidated", () => {
    // The vocabulary is mark8ly's. A console-side list would refuse a status
    // an operator could then never ask for again until somebody redeployed.
    expect(readSessionFilters({ status: "awaiting_kyc_review" }).status).toBe(
      "awaiting_kyc_review",
    );
  });
});

describe("withoutErrorCode", () => {
  it("leaves the sentence a human wrote, without the envelope's code", () => {
    expect(
      withoutErrorCode(
        "onboarding sessions: BAD_REQUEST — created_from must be an RFC 3339 timestamp",
      ),
    ).toBe("created_from must be an RFC 3339 timestamp");
  });

  it("leaves a message that does not carry a code alone", () => {
    expect(withoutErrorCode("the product could not be reached")).toBe(
      "the product could not be reached",
    );
  });
});

describe("sessionsReadError", () => {
  it("surfaces a 400 as the API's own advice, not as a generic failure", () => {
    // The operator mistyped a date; they did not break anything, and the API's
    // sentence names the parameter and gives a valid example.
    const error = sessionsReadError(
      new PlatformApiError(
        "onboarding sessions: BAD_REQUEST — created_from must be an RFC 3339 timestamp, " +
          "for example 2026-08-01T00:00:00Z",
        400,
      ),
      "mark8ly",
    );
    expect(error?.message).toContain("created_from");
    expect(error?.message).toContain("2026-08-01T00:00:00Z");
    expect(error?.message).not.toContain("BAD_REQUEST");
  });

  it("renders a 501 as parked rather than as an error", () => {
    expect(sessionsReadError(new PlatformApiError("nope", 501), "mark8ly")?.unavailable?.title).toBe(
      ONBOARDING_UNAVAILABLE_TITLE,
    );
  });

  it("names the product it could not read for every other failure", () => {
    expect(sessionsReadError(new PlatformApiError("upstream down", 503), "mark8ly")?.message).toContain(
      "mark8ly",
    );
  });
});

describe("sessionsPageState", () => {
  function state(over: Partial<Parameters<typeof sessionsPageState>[0]> = {}) {
    return sessionsPageState({
      sourcesError: null,
      choice: { kind: "source", source: "mark8ly" },
      sessionsError: null,
      page: PAGE,
      filtered: false,
      ...over,
    });
  }

  it("is ready for a page of rows", () => {
    expect(state().kind).toBe("ready");
  });

  it("is empty for an empty list — that is a valid answer", () => {
    expect(state({ page: EMPTY_PAGE }).kind).toBe("empty");
  });

  it("is filtered-empty when a filter is what emptied it", () => {
    // Including a status nothing matches, which is the truthful answer to what
    // was asked and must offer a way back out.
    expect(state({ page: EMPTY_PAGE, filtered: true }).kind).toBe("filtered-empty");
  });

  it("is an error, never empty, for a list that could not be read", () => {
    const resolved = state({
      page: null,
      sessionsError: new PlatformApiError("the sessions could not be read", 503),
    });
    expect(resolved.kind).toBe("error");
  });

  it("says the declarations could not be read, and names no product", () => {
    const resolved = state({
      sourcesError: new PlatformApiError("sources down", 503),
      choice: null,
      page: null,
    });
    expect(resolved.kind === "error" && resolved.message).toBe(SOURCES_UNREADABLE_MESSAGE);
  });

  it("renders an estate that declares nothing as parked", () => {
    expect(state({ choice: { kind: "none-declared" }, page: null }).kind).toBe(
      "instrumentation-unavailable",
    );
  });
});

describe("OnboardingSessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPage(params: Record<string, string | string[]> = {}) {
    return OnboardingSessionsPage({ searchParams: Promise.resolve(params) });
  }

  it("asks the product the deployment declares, with the URL's filters and page", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockResolvedValue(PAGE);

    render(
      await renderPage({ status: "in_progress", abandoned: "true", page: "2" }),
    );

    expect(fetchOnboardingSessions).toHaveBeenCalledWith(
      "mark8ly",
      {
        status: "in_progress",
        abandoned: "true",
        createdFrom: undefined,
        createdTo: undefined,
      },
      2,
    );
  });

  it("renders the merchant, the product's status and the outcome", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockResolvedValue(PAGE);
    render(await renderPage());
    expect(screen.getByText("merchant@example.com")).toBeTruthy();
    expect(screen.getByText("in_progress")).toBeTruthy();
    expect(screen.getByText("In flight")).toBeTruthy();
  });

  it("renders an empty queue as an answer rather than as a failure", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockResolvedValue(EMPTY_PAGE);
    render(await renderPage());
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no rows at all when the list could not be read", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockRejectedValue(
      new PlatformApiError("the sessions could not be read", 503),
    );
    render(await renderPage());
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    expect(screen.getByText(/mark8ly/)).toBeTruthy();
  });

  it("asks no product at all when the declarations could not be read", async () => {
    fetchPlatformSources.mockRejectedValue(new PlatformApiError("sources down", 503));
    fetchOnboardingSessions.mockResolvedValue(PAGE);
    render(await renderPage());
    expect(fetchOnboardingSessions).not.toHaveBeenCalled();
    expect(screen.getByText(SOURCES_UNREADABLE_MESSAGE)).toBeTruthy();
  });

  it("keeps the filter bar when a mistyped window is refused, so the operator can fix it", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockRejectedValue(
      new PlatformApiError(
        "onboarding sessions: BAD_REQUEST — created_from must be an RFC 3339 timestamp, " +
          "for example 2026-08-01T00:00:00Z",
        400,
      ),
    );
    render(await renderPage({ created_from: "2026-08-01" }));
    expect(screen.getByText(/must be an RFC 3339 timestamp/)).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
  });

  it("links back to the funnel for the same product", async () => {
    fetchPlatformSources.mockResolvedValue(SOURCES);
    fetchOnboardingSessions.mockResolvedValue(PAGE);
    render(await renderPage());
    const link = screen.getByRole("link", { name: /back to the funnel/i });
    expect(link.getAttribute("href")).toBe("/platform/onboarding?source=mark8ly");
  });
});
