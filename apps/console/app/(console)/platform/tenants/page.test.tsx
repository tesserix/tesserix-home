import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ESTATE } from "@tesserix/console-core";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "@/components/kit/surface-state";
import { PlatformApiError } from "@/lib/platform-api";
import type { EstateTenant, TenantSourceFailure } from "@/lib/tenants";
import {
  DIRECTORY_EMPTY_MESSAGE,
  DIRECTORY_SCOPE_NOTE,
  DIRECTORY_UNAVAILABLE_MESSAGE,
  DIRECTORY_UNAVAILABLE_TITLE,
  TENANT_FILTERS,
  currentPath,
  directoryState,
  emptyMessageFor,
  readTenantFilters,
  tenantReadError,
  toFilterValues,
} from "./page";
import {
  IncompleteDirectory,
  TenantDirectory,
  formatCreated,
  tenantStatusTone,
  type TenantDirectoryProps,
} from "./tenant-directory";

// `useUrlFilters` reads the router. The directory is rendered here, not the
// page, because a server component cannot be rendered by Testing Library —
// the page's own logic is exercised through its exported pure functions.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/platform/tenants",
  useSearchParams: () => new URLSearchParams(),
}));

const MARK8LY_TENANT: EstateTenant = {
  id: "mark8ly:42",
  source: "mark8ly",
  name: "Acme Stores",
  status: "active",
  ownerEmail: "ops@acme.test",
  createdAt: "2026-03-04T09:00:00.000Z",
};

const KORA_TENANT: EstateTenant = {
  id: "kora:c-9",
  source: "kora",
  name: "Northwind Clinic",
  status: "trial",
};

function renderDirectory(over: Partial<TenantDirectoryProps> = {}) {
  const props: TenantDirectoryProps = {
    descriptors: TENANT_FILTERS,
    values: {},
    tenants: [],
    failures: [],
    state: { kind: "ready" },
    emptyMessage: DIRECTORY_EMPTY_MESSAGE,
    scopeNote: DIRECTORY_SCOPE_NOTE,
    ...over,
  };
  return render(<TenantDirectory {...props} />);
}

describe("readTenantFilters", () => {
  it("keeps a product the surface actually offers", () => {
    expect(readTenantFilters({ product: "mark8ly" })).toEqual({ product: "mark8ly" });
  });

  it("drops a product no descriptor offers", () => {
    // Forwarded, it comes back a 400 from the platform API — so the operator
    // would see a red failure caused by their own stale bookmark.
    expect(readTenantFilters({ product: "not-a-product" })).toEqual({});
  });

  it("ignores a repeated param rather than honouring the first value", () => {
    // The endpoint takes one value per key, so honouring one of the two would
    // apply a filter the bar cannot display.
    expect(readTenantFilters({ product: ["mark8ly", "kora"] })).toEqual({});
  });

  it("trims free text and drops a blank one", () => {
    // An empty `status=` would filter on the empty string upstream rather than
    // mean "any".
    expect(readTenantFilters({ q: "  acme  ", status: "   " })).toEqual({ q: "acme" });
  });

  it("passes a status the console has never heard of straight through", () => {
    // Status is the product's vocabulary; there is nothing to validate it
    // against, and refusing an unfamiliar word would refuse a real filter.
    expect(readTenantFilters({ status: "dormant" })).toEqual({ status: "dormant" });
  });
});

describe("toFilterValues", () => {
  it("shows only the filters the server applied", () => {
    expect(toFilterValues({ product: "kora", q: "acme" })).toEqual({
      product: "kora",
      q: "acme",
    });
    expect(toFilterValues({})).toEqual({});
  });
});

describe("TENANT_FILTERS", () => {
  it("offers every estate product, so a product with no tenants is still askable", () => {
    const options = (TENANT_FILTERS.find((f) => f.key === "product")?.options ?? []).map(
      (o) => o.value,
    );
    expect(options).toEqual(ESTATE.map((product) => product.context));
  });

  it("offers status as free text rather than a fixed list of statuses", () => {
    // A select here would enumerate a vocabulary the console does not own.
    expect(TENANT_FILTERS.find((f) => f.key === "status")?.type).toBe("search");
  });
});

describe("directoryState", () => {
  it("renders rows whenever there are any, even alongside a partial failure", () => {
    // A partial answer is a 200 carrying `failures`, so it must never replace
    // the tenants that WERE read.
    expect(directoryState({ error: null, rows: [MARK8LY_TENANT], filtered: false })).toEqual({
      kind: "ready",
    });
  });

  it("is empty, not an error, when nothing was read and nothing failed", () => {
    expect(directoryState({ error: null, rows: [], filtered: false })).toEqual({
      kind: "empty",
    });
  });

  it("separates 'nothing matches' from 'there are none'", () => {
    expect(directoryState({ error: null, rows: [], filtered: true })).toEqual({
      kind: "filtered-empty",
    });
  });

  it("treats a 501 as not-switched-on, with copy that does not point at the observability park", () => {
    const state = directoryState({
      error: new PlatformApiError("tenants: PLATFORM_API_ORIGIN is not set", 501),
      rows: [],
      filtered: false,
    });
    expect(state).toEqual({
      kind: "instrumentation-unavailable",
      title: DIRECTORY_UNAVAILABLE_TITLE,
      message: DIRECTORY_UNAVAILABLE_MESSAGE,
    });
    // The internal message must not reach the page, and neither must the kit's
    // default remedy — the fix here is configuration, not instrumentation.
    expect(state).not.toHaveProperty("message", INSTRUMENTATION_UNAVAILABLE_MESSAGE);
  });

  it("treats any other failure as a real, retryable error", () => {
    expect(
      directoryState({
        error: new PlatformApiError("tenants: upstream refused", 502),
        rows: [],
        filtered: false,
      }),
    ).toEqual({ kind: "error", message: "tenants: upstream refused" });
  });
});

describe("tenantReadError", () => {
  it("leaves a non-501 without the not-switched-on copy", () => {
    expect(tenantReadError(new PlatformApiError("boom", 502))?.unavailable).toBeUndefined();
  });

  it("is null for no error at all", () => {
    expect(tenantReadError(null)).toBeNull();
  });
});

describe("emptyMessageFor", () => {
  it("claims a census only when nothing was lost", () => {
    expect(emptyMessageFor([])).toBe(DIRECTORY_EMPTY_MESSAGE);
  });

  it("refuses to claim one when a product could not be read", () => {
    const message = emptyMessageFor([{ source: "kora", message: "timeout" }]);
    expect(message).not.toBe(DIRECTORY_EMPTY_MESSAGE);
    expect(message).toMatch(/not evidence that there are none/);
    expect(emptyMessageFor([
      { source: "kora", message: "timeout" },
      { source: "homechef", message: "502" },
    ])).toMatch(/2 products/);
  });
});

describe("currentPath", () => {
  it("carries every param back, not only the ones this surface filters on", () => {
    expect(currentPath({ product: "kora", tab: "x" })).toBe(
      "/platform/tenants?product=kora&tab=x",
    );
    expect(currentPath({})).toBe("/platform/tenants");
  });
});

describe("tenantStatusTone", () => {
  it("ignores casing, because a case difference is not a different state", () => {
    expect(tenantStatusTone("ACTIVE")).toBe("success");
    expect(tenantStatusTone("active")).toBe("success");
  });

  it("falls back to neutral for a status this build has never seen", () => {
    expect(tenantStatusTone("dormant")).toBe("neutral");
  });
});

describe("formatCreated", () => {
  it("prints an unparseable timestamp rather than throwing", () => {
    // `Intl.DateTimeFormat.format` raises RangeError on an Invalid Date, which
    // inside a render replaces the whole table with an error boundary.
    expect(formatCreated("2026-13-45T99:99:99Z")).toBe("2026-13-45T99:99:99Z");
  });

  it("formats a real timestamp in UTC", () => {
    expect(formatCreated("2026-03-04T09:00:00.000Z")).toBe("04 Mar 2026");
  });
});

describe("IncompleteDirectory", () => {
  it("renders nothing when every product answered", () => {
    const { container } = render(<IncompleteDirectory failures={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the product and the reason it could not be read", () => {
    const failures: TenantSourceFailure[] = [
      { source: "kora", message: "upstream timed out after 5s" },
    ];
    render(<IncompleteDirectory failures={failures} />);
    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(screen.getByText(/upstream timed out after 5s/)).toBeInTheDocument();
  });

  it("renders an unknown source id verbatim rather than inventing a name", () => {
    render(<IncompleteDirectory failures={[{ source: "quokka", message: "502" }]} />);
    expect(screen.getByText("quokka")).toBeInTheDocument();
  });
});

describe("TenantDirectory", () => {
  it("renders a tenant's name, status, owner, product and created date", () => {
    renderDirectory({ tenants: [MARK8LY_TENANT] });
    expect(screen.getByText("Acme Stores")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("ops@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Mark8ly")).toBeInTheDocument();
    expect(screen.getByText("04 Mar 2026")).toBeInTheDocument();
    // The product's own id, not the namespaced key the console uses to key it.
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders a status verbatim even when it is not one the console knows", () => {
    renderDirectory({ tenants: [{ ...KORA_TENANT, status: "winding_down" }] });
    expect(screen.getByText("winding_down")).toBeInTheDocument();
  });

  it("shows the tenants it has AND the products it lost, never one instead of the other", () => {
    // The whole point of the surface: a partial estate is honest about being
    // partial, without hiding what was read.
    renderDirectory({
      tenants: [MARK8LY_TENANT],
      failures: [{ source: "homechef", message: "connection refused" }],
    });
    expect(screen.getByText("Acme Stores")).toBeInTheDocument();
    expect(screen.getByText("This directory is incomplete")).toBeInTheDocument();
    expect(screen.getByText("Fe3dr")).toBeInTheDocument();
  });

  it("still names the lost products when there is nothing to tabulate", () => {
    const failures: TenantSourceFailure[] = [{ source: "kora", message: "timeout" }];
    renderDirectory({
      tenants: [],
      failures,
      state: { kind: "empty" },
      emptyMessage: emptyMessageFor(failures),
    });
    expect(screen.getByText("This directory is incomplete")).toBeInTheDocument();
    // And the empty state does not contradict the banner by claiming there
    // are none.
    expect(screen.getByText(/not evidence that there are none/)).toBeInTheDocument();
  });

  it("reads 'not switched on' differently from 'no tenants'", () => {
    renderDirectory({
      state: {
        kind: "instrumentation-unavailable",
        title: DIRECTORY_UNAVAILABLE_TITLE,
        message: DIRECTORY_UNAVAILABLE_MESSAGE,
      },
    });
    expect(screen.getByText(DIRECTORY_UNAVAILABLE_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(DIRECTORY_EMPTY_MESSAGE)).toBeNull();
  });

  it("says what the table does not cover", () => {
    renderDirectory({ tenants: [MARK8LY_TENANT] });
    expect(screen.getByText(DIRECTORY_SCOPE_NOTE)).toBeInTheDocument();
  });

  it("renders an em-dash for a tenant whose product supplied no owner or date", () => {
    renderDirectory({ tenants: [KORA_TENANT] });
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
