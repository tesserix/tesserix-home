import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * WHICH ROW CONTROLS THE DIRECTORY RENDERS (tesserix-home#331, T5).
 *
 * `page.test.tsx` already covers this component's columns, its filters and its
 * incompleteness banner. What nothing covered until now is the question this
 * file exists for: whether a control is MOUNTED at all. The pricing override
 * control was built, tested and deliberately left unrendered for two issues —
 * a state no test could tell from having forgotten to render it, which is
 * exactly the failure mode a mounting test catches.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/tenants",
  useSearchParams: () => new URLSearchParams(),
}));

// Both row controls call server actions. Mocked for the reason each control's
// own test file mocks them: the module is `"use server"` over `server-only`
// seams, and nothing here drives a submission.
vi.mock("./actions", () => ({
  setTenantLifecycleAction: vi.fn(),
  grantTenantPricingOverrideAction: vi.fn(),
  revokeTenantPricingOverrideAction: vi.fn(),
}));

import type { EstateTenant } from "@/lib/tenants";
import { TenantDirectory, type TenantDirectoryProps } from "./tenant-directory";

const MARK8LY: EstateTenant = {
  id: "mark8ly:42",
  source: "mark8ly",
  name: "Acme Stores",
  status: "active",
};

/** A tenant belonging to a product this console does not mint coupons for. */
const OTHER: EstateTenant = {
  id: "kora:c-9",
  source: "kora",
  name: "Northwind Clinic",
  status: "active",
};

/** Enough of mark8ly's §8.8 vocabulary for the lifecycle control to render its
 *  verb rather than the "this product published no codes" gap. */
const REASON_CODES = {
  mark8ly: { suspend: [{ code: "nonpayment", label: "Non-payment" }] },
};

function renderDirectory(tenants: readonly EstateTenant[]) {
  const props: TenantDirectoryProps = {
    descriptors: [],
    values: {},
    tenants,
    failures: [],
    reasonCodes: REASON_CODES,
    state: { kind: "ready" },
    emptyMessage: "No tenants.",
    scopeNote: "Every product's tenants.",
  };
  return render(<TenantDirectory {...props} />);
}

describe("the controls on a tenant's row", () => {
  it("renders the pricing override control beside the lifecycle one", () => {
    renderDirectory([MARK8LY]);

    // By the tenant-specific accessible name each control gives its button:
    // every row renders the same visible text, so the name is the only handle
    // that addresses one tenant's control rather than any row's.
    expect(
      screen.getByRole("button", { name: "Pricing override for Acme Stores" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retire pricing override for Acme Stores" }),
    ).toBeInTheDocument();
    // The lifecycle control is still there, under its own verb — an `active`
    // tenant offers "Suspend". A mounting test that only asserted the new
    // control would pass just as happily with the old one deleted.
    expect(screen.getByRole("button", { name: "Suspend Acme Stores" })).toBeInTheDocument();
  });

  it("renders one pricing override control per row, not one per table", () => {
    renderDirectory([MARK8LY, { ...MARK8LY, id: "mark8ly:43", name: "Beta Goods" }]);

    expect(
      screen.getByRole("button", { name: "Pricing override for Beta Goods" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Pricing override for/ })).toHaveLength(2);
  });

  it("still renders the control, disabled, for a product this console does not mint for", () => {
    renderDirectory([OTHER]);

    // Disabled with the reason beside it rather than hidden: a control that
    // vanishes for some rows reads as a rendering fault. The control decides
    // this itself — what is asserted here is that the row reaches it.
    expect(screen.getByRole("button", { name: "Pricing override" })).toBeDisabled();
    expect(screen.getByText(/Pricing overrides are minted only for/)).toBeInTheDocument();
  });
});
