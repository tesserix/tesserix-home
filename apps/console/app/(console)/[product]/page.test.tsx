import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchProductKpis = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchProductKpis: (...args: unknown[]) => fetchProductKpis(...args),
}));

class NotFoundError extends Error {}
const notFound = vi.fn(() => {
  // Next's own `notFound()` throws to unwind the render, and the page relies
  // on that: everything after the call must not run.
  throw new NotFoundError("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

import { PlatformApiError } from "@/lib/platform-api";
import { KPIS_UNAVAILABLE_MESSAGE, KPIS_UNAVAILABLE_TITLE } from "@/lib/kpis";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "@/components/kit/surface-state";
import ProductOverviewPage, { overviewState } from "./page";

/**
 * The page is a server component; its default export is an async function that
 * can be awaited and the result rendered — the same pattern
 * `kora/page.test.tsx` uses.
 */
async function renderProduct(product: string) {
  render(await ProductOverviewPage({ params: Promise.resolve({ product }) }));
}

function rejectWith(status: number, message: string) {
  fetchProductKpis.mockRejectedValue(new PlatformApiError(message, status));
}

describe("overviewState", () => {
  it("is ready when a map arrived", () => {
    expect(overviewState(null, { orders_today: 1 }).kind).toBe("ready");
  });

  it("maps a 501 to instrumentation-unavailable carrying this read's copy", () => {
    const state = overviewState(new PlatformApiError("nope", 501), null);
    expect(state).toEqual({
      kind: "instrumentation-unavailable",
      title: KPIS_UNAVAILABLE_TITLE,
      message: KPIS_UNAVAILABLE_MESSAGE,
    });
  });

  it("leaves a 503 an error — the dangerous direction", () => {
    // 503 means the product could not be REACHED. Rendering it as "no
    // metrics" would tell an operator a number does not exist when it exists
    // and cannot be read.
    expect(overviewState(new PlatformApiError("upstream down", 503), null).kind).toBe("error");
  });
});

describe("/[product]", () => {
  it("reads the product's federation slug", async () => {
    // `source` equals the registry key for both products today, so this row
    // cannot distinguish `productSource(id)` from the raw param. It pins the
    // wire value the endpoint is given; `ProductEntry.source` is where the
    // two are allowed to diverge, and `products.test.ts` owns that.
    fetchProductKpis.mockResolvedValue({ orders_today: 42 });
    await renderProduct("mark8ly");
    expect(fetchProductKpis).toHaveBeenCalledWith("mark8ly");
  });

  it("renders a tile per metric key, including a string and a bool", async () => {
    fetchProductKpis.mockResolvedValue({
      orders_today: 42,
      checkout_status: "healthy",
      migration_running: true,
    });

    await renderProduct("mark8ly");

    expect(screen.getByText("Orders today")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Checkout status")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("Migration running")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  // THE NEGATIVE CONTROL for the 501 trap. Swap `kpisReadError` for
  // `toSurfaceError` in the page and this row goes red: the callout falls back
  // to the kit's default, which sends an operator to a parked observability
  // plane that has nothing to do with this read.
  it("renders a 501 with this read's copy, not the observability-park default", async () => {
    rejectWith(501, "kpis: not instrumented");

    await renderProduct("mark8ly");

    expect(screen.getByText(KPIS_UNAVAILABLE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(KPIS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(INSTRUMENTATION_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(document.body.textContent).not.toContain("observability-park");
    // And no tiles: there is nothing to show, and a stale grid beside the
    // callout would contradict it.
    expect(screen.queryByText("Orders today")).toBeNull();
  });

  it("renders a 503 as an error, never as 'no metrics'", async () => {
    rejectWith(503, "kpis: upstream unavailable");

    await renderProduct("mark8ly");

    // `ErrorState`'s `server_error` heading, and the read's own message as its
    // description — a failure, offered as one.
    expect(screen.getByText("Something Went Wrong")).toBeInTheDocument();
    expect(screen.getByText("kpis: upstream unavailable")).toBeInTheDocument();
    // And emphatically NOT the 501 state: 503 means the product could not be
    // reached, and "no headline metrics yet" would be a lie about a number
    // that exists.
    expect(screen.queryByText(KPIS_UNAVAILABLE_TITLE)).toBeNull();
  });

  it("answers not-found for a segment that is not a product, before any read", async () => {
    fetchProductKpis.mockClear();
    // `platform` specifically: `routing.test.ts` measures that `/platform`
    // reaches this page, so this is the live case, not a hypothetical one.
    await expect(renderProduct("platform")).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalled();
    expect(fetchProductKpis).not.toHaveBeenCalled();
  });

  it("answers not-found for a product the console does not serve", async () => {
    fetchProductKpis.mockClear();
    await expect(renderProduct("homechef")).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchProductKpis).not.toHaveBeenCalled();
  });
});
