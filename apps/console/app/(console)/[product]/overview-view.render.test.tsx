import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KPIS_UNAVAILABLE_MESSAGE, KPIS_UNAVAILABLE_TITLE } from "@/lib/kpis";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "@/components/kit/surface-state";
import {
  ProductOverview,
  metricLabel,
  metricValueText,
  type ProductOverviewProps,
} from "./overview-view";

const BASE: ProductOverviewProps = {
  productLabel: "Mark8ly",
  metrics: { orders_today: 42 },
  state: { kind: "ready" },
  reauthReturnTo: "/mark8ly",
};

function renderOverview(overrides: Partial<ProductOverviewProps> = {}) {
  return render(<ProductOverview {...BASE} {...overrides} />);
}

describe("metricLabel", () => {
  it("turns a snake_case key into a sentence", () => {
    expect(metricLabel("orders_today")).toBe("Orders today");
  });

  it("handles hyphens and runs of separators", () => {
    expect(metricLabel("active-users")).toBe("Active users");
    expect(metricLabel("__gmv__usd__")).toBe("Gmv usd");
  });

  it("leaves a single word alone but for its first letter", () => {
    expect(metricLabel("revenue")).toBe("Revenue");
  });

  // Deliberate, and the reason is on the function: the keys are the product's
  // own and nothing in the console enumerates them, so splitting camelCase
  // would be the console guessing at a vocabulary it has no source for.
  it("does not split camelCase", () => {
    expect(metricLabel("ordersToday")).toBe("OrdersToday");
  });

  it("falls back to the raw key when the derivation leaves nothing", () => {
    // `parseProductKpis` accepts any string key. The fallback is what stops a
    // key of separators rendering as a blank tile; a key that IS the empty
    // string still renders empty, because there is nothing else to show.
    expect(metricLabel("")).toBe("");
    expect(metricLabel("__")).toBe("__");
  });
});

describe("metricValueText", () => {
  it("passes numbers through as numbers", () => {
    expect(metricValueText(42)).toBe(42);
    expect(metricValueText(0)).toBe(0);
  });

  it("passes strings through unchanged", () => {
    expect(metricValueText("healthy")).toBe("healthy");
  });

  it("spells a boolean out rather than translating it", () => {
    expect(metricValueText(true)).toBe("true");
    expect(metricValueText(false)).toBe("false");
  });
});

describe("ProductOverview", () => {
  it("renders one tile per metric key, whatever the value's type", () => {
    renderOverview({
      metrics: { orders_today: 42, status: "healthy", degraded: false },
    });

    expect(screen.getByText("Orders today")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
  });

  it("renders no tiles and no state view when the read produced nothing", () => {
    const { container } = renderOverview({ metrics: null, state: { kind: "ready" } });
    // A `ready` state renders nothing from `SurfaceStateView`, and a null map
    // renders no section — the page never puts this pair together, and the
    // component must not invent a tile if it ever did.
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows this read's own 501 copy, not the observability-park default", () => {
    renderOverview({
      metrics: null,
      state: {
        kind: "instrumentation-unavailable",
        title: KPIS_UNAVAILABLE_TITLE,
        message: KPIS_UNAVAILABLE_MESSAGE,
      },
    });

    expect(screen.getByText(KPIS_UNAVAILABLE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(KPIS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    // The default sends an operator to `docs/observability-park.md`, which
    // describes nothing that is happening here.
    expect(screen.queryByText(INSTRUMENTATION_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(document.body.textContent).not.toContain("observability-park");
  });

  it("renders a failed read as an error, with no tiles", () => {
    renderOverview({ metrics: null, state: { kind: "error", message: "boom" } });
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("Orders today")).toBeNull();
  });

  it("offers a sign-in link back to this product when the session cannot reach the API", () => {
    renderOverview({ metrics: null, state: { kind: "reauth-required" } });
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/auth/login?returnTo=%2Fmark8ly",
    );
  });
});
