import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

// The action is a `"use server"` module whose seam is `server-only`. Mocked for
// the same reason `tenant-lifecycle-controls.test.tsx` mocks its sibling: the
// component imports it directly (the house pattern), and these tests need to
// drive every result shape the seam can produce. The lifecycle action is
// declared too because the module exports both and an unmocked export would be
// `undefined` in this file's module graph.
vi.mock("./actions", () => ({
  grantTenantPricingOverrideAction: vi.fn(),
  setTenantLifecycleAction: vi.fn(),
}));

import { sourceLabel } from "@/lib/audit";
import type { EstateTenant } from "@/lib/tenants";
import { grantTenantPricingOverrideAction } from "./actions";
import {
  EMPTY_OVERRIDE_FORM,
  OVERRIDE_NOT_CONFIRMED,
  TenantPricingOverrideAction,
  overrideDiscount,
  overrideFieldPlacement,
  overrideMintedMessage,
  overrideSubmittable,
  overrideUnavailableNotice,
  type OverrideForm,
} from "./tenant-pricing-override-controls";

afterEach(() => {
  vi.resetAllMocks();
});

const TENANT: EstateTenant = {
  id: "mark8ly:42",
  source: "mark8ly",
  name: "Acme Stores",
  status: "active",
};

/** A tenant belonging to a product this console does not mint coupons for. */
const OTHER_PRODUCT: EstateTenant = {
  id: "kora:c-9",
  source: "kora",
  name: "Northwind Clinic",
  status: "active",
};

/** A complete form, built from the shipped empty one so a field added to
 *  `OverrideForm` cannot be silently missing from every test here. */
const COMPLETE: OverrideForm = {
  ...EMPTY_OVERRIDE_FORM,
  mode: "live",
  kind: "percent_off",
  percentOff: "20",
  duration: "once",
  label: "Launch partner discount",
  reason: "Agreed with sales for the pilot cohort.",
};

/* ------------------------------------------------------------------------ *
 * What the operator is told after a mint
 * ------------------------------------------------------------------------ */

describe("the success copy never says the discount is in force", () => {
  const message = overrideMintedMessage("Acme Stores", "co_abc123", "live");

  it("does not claim the discount was granted, applied, or made active", () => {
    // The words, not the sentence. A future rewording that sounds friendlier
    // and means something untrue is the failure worth guarding, and asserting
    // the exact string would pass any rewording that kept the length.
    for (const forbidden of ["granted", "applied", "active", "discounted", "in force"]) {
      expect(message.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("says the tenant is still being charged list price", () => {
    expect(message).toContain("not yet in effect");
    expect(message).toContain("still being charged list price");
  });

  it("names the coupon, the mode and the tenant", () => {
    // The coupon id is the operator's only handle on the object that now
    // exists; the mode is the choice that silently does nothing if it is
    // wrong, and after the dialog closes this line is the only place it shows.
    expect(message).toContain("co_abc123");
    expect(message).toContain("live mode");
    expect(message).toContain("Acme Stores");
  });
});

/* ------------------------------------------------------------------------ *
 * The pure functions over the form
 * ------------------------------------------------------------------------ */

describe("nothing on this form is defaulted", () => {
  it("ships an empty form with no mode, no discount kind and no duration", () => {
    expect(EMPTY_OVERRIDE_FORM.mode).toBe("");
    expect(EMPTY_OVERRIDE_FORM.kind).toBe("");
    expect(EMPTY_OVERRIDE_FORM.duration).toBe("");
    // Not defaulted either, unlike the promo author form's `usd` — nothing in
    // this dialog knows what currency one named tenant is billed in.
    expect(EMPTY_OVERRIDE_FORM.currency).toBe("");
  });

  it("yields no discount while the duration is unchosen", () => {
    expect(overrideDiscount({ ...COMPLETE, duration: "" })).toBeUndefined();
  });

  it("yields no discount while the kind is unchosen", () => {
    expect(overrideDiscount({ ...COMPLETE, kind: "" })).toBeUndefined();
  });

  it("refuses to submit until a mode is chosen", () => {
    expect(overrideSubmittable({ ...COMPLETE, mode: "" })).toBe(false);
    expect(overrideSubmittable(COMPLETE)).toBe(true);
  });
});

describe("a repeating discount and its months", () => {
  it("yields no discount while a repeating one has no month count", () => {
    expect(overrideDiscount({ ...COMPLETE, duration: "repeating" })).toBeUndefined();
    expect(
      overrideDiscount({ ...COMPLETE, duration: "repeating", months: "not a number" }),
    ).toBeUndefined();
  });

  it("carries the month count for a repeating discount", () => {
    expect(overrideDiscount({ ...COMPLETE, duration: "repeating", months: "3" })).toEqual({
      kind: "percent_off",
      percentOff: 20,
      duration: "repeating",
      durationInMonths: 3,
    });
  });

  it("DISCARDS months typed before the duration was changed away from repeating", () => {
    // The seam refuses a month count on a `once` discount, and the months
    // input is not even rendered at that point — so carrying it would be a
    // refusal for a form that reads, on screen, as correct.
    expect(overrideDiscount({ ...COMPLETE, duration: "forever", months: "3" })).toEqual({
      kind: "percent_off",
      percentOff: 20,
      duration: "forever",
      durationInMonths: null,
    });
  });
});

describe("an amount-off discount", () => {
  const amountOff: OverrideForm = {
    ...COMPLETE,
    kind: "amount_off",
    percentOff: "",
    amountOff: "1500",
    currency: "gbp",
  };

  it("carries the amount and the currency", () => {
    expect(overrideDiscount(amountOff)).toEqual({
      kind: "amount_off",
      amountOffMinor: 1500,
      currency: "gbp",
      duration: "once",
      durationInMonths: null,
    });
  });

  it("yields no discount without a currency", () => {
    expect(overrideDiscount({ ...amountOff, currency: "   " })).toBeUndefined();
  });
});

describe("the label and the reason are both mandatory", () => {
  it("refuses to submit with either one blank", () => {
    expect(overrideSubmittable({ ...COMPLETE, label: "   " })).toBe(false);
    expect(overrideSubmittable({ ...COMPLETE, reason: "   " })).toBe(false);
  });
});

describe("where a refusal's message is shown", () => {
  it("puts each field the seam names on that field's own input", () => {
    expect(overrideFieldPlacement("label")).toBe("label");
    expect(overrideFieldPlacement("reason")).toBe("reason");
    expect(overrideFieldPlacement("discount")).toBe("discount");
    expect(overrideFieldPlacement("duration")).toBe("duration");
    expect(overrideFieldPlacement("durationInMonths")).toBe("durationInMonths");
  });

  it("falls back to the form for a field this dialog does not render", () => {
    // A message that lands nowhere is indistinguishable, on screen, from a
    // request that succeeded.
    expect(overrideFieldPlacement(undefined)).toBe("form");
    expect(overrideFieldPlacement("somethingTheSeamGrewLater")).toBe("form");
  });
});

/* ------------------------------------------------------------------------ *
 * The control
 * ------------------------------------------------------------------------ */

async function openDialog(tenant: EstateTenant = TENANT) {
  const user = userEvent.setup();
  render(<TenantPricingOverrideAction tenant={tenant} />);
  await user.click(screen.getByRole("button", { name: `Pricing override for ${tenant.name}` }));
  return user;
}

/** Fills every control the complete form describes, through the UI. */
async function fillComplete(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Stripe account"), "live");
  await user.selectOptions(screen.getByLabelText("Discount"), "percent_off");
  await user.type(screen.getByLabelText("Percent off"), "20");
  await user.selectOptions(screen.getByLabelText("How long it lasts"), "once");
  await user.type(screen.getByLabelText("Name on the tenant's invoice"), COMPLETE.label);
  await user.type(screen.getByLabelText("Why (internal)"), COMPLETE.reason);
}

describe("a tenant belonging to a product this console does not mint for", () => {
  it("disables the action and says why", () => {
    render(<TenantPricingOverrideAction tenant={OTHER_PRODUCT} />);
    expect(screen.getByRole("button", { name: "Pricing override" })).toBeDisabled();
    expect(screen.getByText(overrideUnavailableNotice("kora"))).toBeInTheDocument();
  });

  it("names both products in the notice, in their display names", () => {
    // Through `sourceLabel`, the estate's product-name lookup — so a product
    // whose id this build does not know appears under its raw id rather than
    // as "Unknown", the property the directory already relies on.
    const notice = overrideUnavailableNotice("kora");
    expect(notice).toContain(sourceLabel("mark8ly"));
    expect(notice).toContain(sourceLabel("kora"));
  });
});

describe("the dialog", () => {
  it("opens with the mode and the duration unchosen", async () => {
    await openDialog();
    expect(screen.getByLabelText("Stripe account")).toHaveValue("");
    expect(screen.getByLabelText("How long it lasts")).toHaveValue("");
    expect(screen.getByLabelText("Discount")).toHaveValue("");
  });

  it("reveals the months input only for a repeating discount", async () => {
    const user = await openDialog();
    await user.selectOptions(screen.getByLabelText("How long it lasts"), "forever");
    expect(screen.queryByLabelText("Months")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("How long it lasts"), "repeating");
    expect(screen.getByLabelText("Months")).toBeInTheDocument();
  });

  it("distinguishes the invoice name from the internal reason by their audience", async () => {
    await openDialog();
    // Not merely two boxes: an operator who typed the second into the first
    // has published their private justification to the merchant.
    expect(
      screen.getByText("The tenant reads this beside the discount on their invoice."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Never sent to Stripe and never shown to the tenant. Recorded against the grant.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until every choice is made", async () => {
    const user = await openDialog();
    const confirm = screen.getByRole("button", { name: "Mint coupon" });
    expect(confirm).toBeDisabled();
    await fillComplete(user);
    expect(confirm).toBeEnabled();
  });
});

describe("a mint the seam accepted", () => {
  it("sends the namespaced tenant id, the chosen mode, the terms, the label and the reason", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    expect(grantTenantPricingOverrideAction).toHaveBeenCalledWith({
      tenantId: "mark8ly:42",
      mode: "live",
      discount: {
        kind: "percent_off",
        percentOff: 20,
        duration: "once",
        durationInMonths: null,
      },
      label: COMPLETE.label,
      reason: COMPLETE.reason,
    });
  });

  it("tells the operator a coupon exists and that the tenant's price has not moved", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(overrideMintedMessage("Acme Stores", "co_abc123", "live"));
    // The directory is the products' answer, so it is re-read rather than
    // patched locally.
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("when the mint is refused", () => {
  it("attaches a refused label to the invoice-name input, not the form", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: false,
      message: "That name is too long for an invoice line.",
      field: "label",
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    const input = screen.getByLabelText("Name on the tenant's invoice");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const described = input.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described as string)).toHaveTextContent(
      "That name is too long for an invoice line.",
    );
    // The reason field is untouched — the two are not interchangeable.
    expect(screen.getByLabelText("Why (internal)")).not.toHaveAttribute("aria-invalid");
  });

  it("shows a refusal naming no field, and one naming a field it does not render, at form level", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: false,
      message: "This tenant already has a coupon minted in live mode (co_old).",
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This tenant already has a coupon minted in live mode (co_old).",
    );
    // AT FORM LEVEL, asserted by where it is NOT. "The message appears
    // somewhere" is satisfied just as happily by pinning every refusal to one
    // input, which would put "this tenant already has a coupon" under the
    // invoice-name box and tell the operator to fix a field that is fine.
    expect(screen.getByLabelText("Name on the tenant's invoice")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.getByLabelText("Why (internal)")).not.toHaveAttribute("aria-invalid");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not lose a refusal naming a field this dialog does not render", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: false,
      message: "Something this build has never seen.",
      field: "somethingTheSeamGrewLater",
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something this build has never seen.",
    );
  });

  it("never claims nothing happened when the call itself failed", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockRejectedValue(new Error("offline"));
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(OVERRIDE_NOT_CONFIRMED);
    expect(OVERRIDE_NOT_CONFIRMED.toLowerCase()).not.toContain("nothing");
    expect(refresh).not.toHaveBeenCalled();
  });
});
