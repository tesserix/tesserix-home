import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchProductEntities = vi.fn();
const fetchEstateInbox = vi.fn();
const fetchKoraAiMetrics = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchProductEntities: (...args: unknown[]) => fetchProductEntities(...args),
  fetchEstateInbox: (...args: unknown[]) => fetchEstateInbox(...args),
  fetchKoraAiMetrics: (...args: unknown[]) => fetchKoraAiMetrics(...args),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { EntityPage } from "@/lib/entities";
import type { EstateInbox } from "@/lib/inbox";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import KoraOverviewPage, { tileState } from "./page";

/**
 * The page is a server component and cannot be rendered by Testing Library
 * directly for its logic, but its default export IS an async function that
 * can be awaited and the result rendered — the same pattern
 * `platform/billing/catalog/page.test.tsx` uses for `PlanCatalog`.
 */

const FOODS_PAGE = (total: number): EntityPage => ({
  data: total > 0 ? [{ id: "kora:1", source: "kora", type: "foods", label: "Veg" }] : [],
  pagination: { page: 1, limit: 1, total },
});

const USERS_PAGE = (total: number): EntityPage => ({
  data: total > 0 ? [{ id: "kora:2", source: "kora", type: "users", label: "Ann" }] : [],
  pagination: { page: 1, limit: 1, total },
});

const INBOX = (total: number): EstateInbox => ({
  items:
    total > 0
      ? [
          {
            id: "i1",
            source: "kora",
            kind: "unresolved_food",
            title: "Unresolved food",
            waitingSince: "2026-08-20T00:00:00Z",
            actions: [],
          },
        ]
      : [],
  total,
  failures: [],
});

const AI_METRICS = (firstTryRatePct?: number): KoraAiMetrics => ({
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: { attempts: 10, needsHuman: 1, byKind: { exact: 8, fuzzy: 2 }, firstTryRatePct },
  users: [],
});

function setUpSuccessfulReads() {
  fetchProductEntities.mockImplementation((source: string, type: string) => {
    if (type === "foods") return Promise.resolve(FOODS_PAGE(6421));
    if (type === "users") return Promise.resolve(USERS_PAGE(318));
    throw new Error(`unexpected entity type ${type}`);
  });
  fetchEstateInbox.mockResolvedValue(INBOX(4));
  fetchKoraAiMetrics.mockResolvedValue(AI_METRICS(78));
}

async function renderPage() {
  render(await KoraOverviewPage());
}

describe("tileState", () => {
  it("resolves ready when rows are present and nothing failed", () => {
    expect(tileState(null, [{ id: 1 }]).kind).toBe("ready");
  });

  it("resolves empty when the read succeeded with no rows", () => {
    expect(tileState(null, []).kind).toBe("empty");
  });

  it("resolves instrumentation-unavailable for a 501", () => {
    expect(tileState(new PlatformApiError("not configured", 501), []).kind).toBe(
      "instrumentation-unavailable",
    );
  });

  it("resolves error for a genuine failure, distinct from a 501", () => {
    expect(tileState(new PlatformApiError("boom", 503), []).kind).toBe("error");
  });
});

describe("KoraOverviewPage — four independent reads", () => {
  it("asks the Foods and Users tiles for a count only — limit 1, not the index pages' 50", async () => {
    setUpSuccessfulReads();
    await renderPage();

    const foodsCall = fetchProductEntities.mock.calls.find((call) => call[1] === "foods");
    const usersCall = fetchProductEntities.mock.calls.find((call) => call[1] === "users");
    // (source, type, search, page, limit)
    expect(foodsCall).toEqual(["kora", "foods", undefined, 1, 1]);
    expect(usersCall).toEqual(["kora", "users", undefined, 1, 1]);
  });

  it("scopes the inbox read to kora", async () => {
    setUpSuccessfulReads();
    await renderPage();
    expect(fetchEstateInbox).toHaveBeenCalledWith("kora");
  });

  it("renders every tile's total when every read succeeds", async () => {
    setUpSuccessfulReads();
    await renderPage();
    expect(screen.getByText("6421")).toBeInTheDocument();
    expect(screen.getByText("318")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });

  // THE case this task exists to protect: a successful read whose
  // first_try_rate_pct is absent must render "Not measured", never 0%.
  it("renders 'Not measured' when Kora's window measured no attempts, not 0%", async () => {
    setUpSuccessfulReads();
    fetchKoraAiMetrics.mockResolvedValue(AI_METRICS(undefined));
    await renderPage();
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });

  // A failed read must not take down the other three tiles.
  it("keeps the other three tiles ready when the AI metrics read fails", async () => {
    setUpSuccessfulReads();
    fetchKoraAiMetrics.mockRejectedValue(new PlatformApiError("kora unreachable", 503));
    await renderPage();
    expect(screen.getByText("6421")).toBeInTheDocument();
    expect(screen.getByText("318")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  // A 501 (this deployment does not federate Kora at all) is a legitimate
  // state, distinct from a genuine failure — it must render as "not
  // measured", not as an error line, and it must not take the other tiles
  // down with it either.
  it("renders the AI tile as not measured, not an error, when Kora is not federated", async () => {
    setUpSuccessfulReads();
    fetchKoraAiMetrics.mockRejectedValue(new PlatformApiError("not configured", 501));
    await renderPage();
    expect(screen.getByText("6421")).toBeInTheDocument();
    expect(screen.getAllByText("Not measured").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders zero as a real empty count, not a failure", async () => {
    fetchProductEntities.mockImplementation((source: string, type: string) => {
      if (type === "foods") return Promise.resolve(FOODS_PAGE(0));
      if (type === "users") return Promise.resolve(USERS_PAGE(318));
      throw new Error(`unexpected entity type ${type}`);
    });
    fetchEstateInbox.mockResolvedValue(INBOX(0));
    fetchKoraAiMetrics.mockResolvedValue(AI_METRICS(0));
    await renderPage();
    // A genuinely measured 0% is a real, different fact from "not measured".
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
