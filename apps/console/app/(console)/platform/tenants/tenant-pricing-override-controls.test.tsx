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
  revokeTenantPricingOverrideAction: vi.fn(),
  setTenantLifecycleAction: vi.fn(),
}));

import { sourceLabel } from "@/lib/audit";
// TYPE-ONLY, the discipline the control itself keeps: `tenant-discount-write`
// is `server-only`, and `import type` is erased.
import type { TenantDiscountResult } from "@/lib/tenant-discount-write";
import type { EstateTenant } from "@/lib/tenants";
import { grantTenantPricingOverrideAction, revokeTenantPricingOverrideAction } from "./actions";
import {
  EMPTY_OVERRIDE_FORM,
  EMPTY_OVERRIDE_REVOKE_FORM,
  OVERRIDE_NOT_CONFIRMED,
  OVERRIDE_REVOKE_NOT_CONFIRMED,
  TenantPricingOverrideAction,
  overrideDiscount,
  overrideFieldPlacement,
  overrideMintedMessage,
  overrideRetiredMessage,
  overrideRevokeSubmittable,
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
 * mark8ly's reports, as the seam hands them over
 * ------------------------------------------------------------------------ */

/** Every store took the coupon. */
const ALL_APPLIED: TenantDiscountResult = {
  ok: true,
  status: "ok",
  requiresReconciliation: false,
  stores: [
    { storeId: "store-1", outcome: "applied" },
    { storeId: "store-2", outcome: "already_applied" },
  ],
};

/** One store took it, one store's transaction rolled back. `failureReason` is
 *  mark8ly's own fixed sentence — `storeFailure` composes one of five from the
 *  failure code and never from driver text. */
const PARTIAL: TenantDiscountResult = {
  ok: true,
  status: "partial",
  requiresReconciliation: false,
  stores: [
    { storeId: "store-1", outcome: "applied" },
    {
      storeId: "store-2",
      outcome: "failed",
      failureReason: "the stripe call failed and nothing was changed for this store; it can be retried",
    },
  ],
};

/** A card-less trialing store: mark8ly reports `ok`, and no discount is in
 *  force anywhere. The case that makes counting outcomes, rather than reading
 *  `status`, the honest summary. */
const ALL_PENDING: TenantDiscountResult = {
  ok: true,
  status: "ok",
  requiresReconciliation: false,
  stores: [{ storeId: "store-1", outcome: "pending" }],
};

/** Stripe moved and mark8ly could not write the row explaining it. */
const RECONCILE: TenantDiscountResult = {
  ok: true,
  status: "partial",
  requiresReconciliation: true,
  stores: [
    { storeId: "store-1", outcome: "applied" },
    {
      storeId: "store-2",
      outcome: "failed",
      failureReason:
        "stripe accepted the discount change but the audit row was not written, so the change was rolled back locally and stripe and this service now disagree; this store requires manual reconciliation",
    },
  ],
};

/** mark8ly never answered. */
const UNREPORTED: TenantDiscountResult = {
  ok: false,
  message:
    "The product could not be reached to put this coupon on this tenant's subscriptions, and whether it did cannot be told from here. Check the tenant's subscriptions in mark8ly before trying again.",
};

/** Every store gave the coupon back. */
const ALL_DETACHED: TenantDiscountResult = {
  ok: true,
  status: "ok",
  requiresReconciliation: false,
  stores: [
    { storeId: "store-1", outcome: "removed" },
    { storeId: "store-2", outcome: "not_applied" },
  ],
};

/** One store gave it back and one did not. */
const PARTIAL_DETACH: TenantDiscountResult = {
  ok: true,
  status: "partial",
  requiresReconciliation: false,
  stores: [
    { storeId: "store-1", outcome: "removed" },
    {
      storeId: "store-2",
      outcome: "failed",
      failureReason: "this store's subscription could not be read, so nothing was changed for it",
    },
  ],
};

/** The detach never reached mark8ly. */
const UNREPORTED_DETACH: TenantDiscountResult = {
  ok: false,
  message:
    "The product could not be reached to take this coupon off this tenant's subscriptions, and whether it did cannot be told from here. Check the tenant's subscriptions in mark8ly before trying again.",
};

/**
 * Claims that a discount is IN FORCE.
 *
 * The forbidden list is kept, and what it means has changed: "applied" is now
 * sayable, because mark8ly reports per store whether it applied the coupon and
 * saying so where it is true is the whole point of this PR. What must never be
 * said is that the tenant IS discounted when no store carries it — which is
 * every one of these phrases, and none of them is a synonym of the outcome
 * words a report lists.
 */
const CLAIMS_IN_FORCE = [
  "in force",
  "is applied to",
  "is now active",
  "is being charged less",
  "is discounted",
];

/* ------------------------------------------------------------------------ *
 * What the operator is told after a mint
 * ------------------------------------------------------------------------ */

describe("the mint copy says a discount is in force only where mark8ly said so", () => {
  const applied = overrideMintedMessage("Acme Stores", "co_abc123", "live", ALL_APPLIED);
  const partial = overrideMintedMessage("Acme Stores", "co_abc123", "live", PARTIAL);
  const pending = overrideMintedMessage("Acme Stores", "co_abc123", "live", ALL_PENDING);
  const unreported = overrideMintedMessage("Acme Stores", "co_abc123", "live", UNREPORTED);

  it("names the coupon, the mode and the tenant, whatever mark8ly reported", () => {
    // Unchanged from the pre-attach copy and for its reasons: the coupon id is
    // the operator's only handle on the object, and after the dialog closes
    // this line is the only place the mode is still visible.
    for (const message of [applied, partial, pending, unreported]) {
      expect(message).toContain("co_abc123");
      expect(message).toContain("live mode");
      expect(message).toContain("Acme Stores");
    }
  });

  it("says the coupon is applied when every store took it, and counts them", () => {
    // "Applied" IS sayable here — this is what T3 shipped. The guard below is
    // what keeps it from being said anywhere else.
    expect(applied).toMatch(/applied it to all 2 of their stores/);
  });

  it("never claims a pending store is in force — it has no Stripe subscription", () => {
    // mark8ly reports `status: "ok"` for this fan-out, because no store's
    // transaction failed. Nothing is discounted all the same, which is why the
    // copy counts outcomes rather than reading the status line.
    for (const forbidden of CLAIMS_IN_FORCE) {
      expect(pending.toLowerCase()).not.toContain(forbidden);
    }
    expect(pending).toContain("store-1");
    expect(pending).toContain("pending");
  });

  it("names the stores that did not get it, and mark8ly's own reason", () => {
    expect(partial).toMatch(/applied it to 1 of 2 stores/);
    expect(partial).toContain("store-2");
    // The failure reason is mark8ly's fixed vocabulary, not driver text — so
    // it is shown rather than replaced with a sentence this console invented.
    expect(partial).toContain("the stripe call failed and nothing was changed for this store");
    // And the store that DID take it is not listed among the misses.
    expect(partial).not.toMatch(/store-1 \(/);
  });

  it("says plainly that nothing is carrying it when nothing is", () => {
    expect(pending).toMatch(/no store is carrying it/i);
    expect(unreported).toContain(UNREPORTED.message);
  });

  it("never claims the discount is in force when mark8ly did not answer", () => {
    // The minted-but-not-applied case. The coupon exists; whether any store
    // carries it is unknown, and unknown must not read as done.
    for (const forbidden of CLAIMS_IN_FORCE) {
      expect(unreported.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("never says nothing happened, because the coupon exists either way", () => {
    // NOT `partial`, and that is not a hole. mark8ly's own per-store sentence
    // for a failed Stripe call contains "nothing was changed for this store",
    // which is true of THAT store and is quoted verbatim by design. The claim
    // guarded against is the console's own — that the operation as a whole did
    // nothing — so the guard runs on the messages this console wrote alone.
    for (const message of [applied, pending, unreported]) {
      expect(message.toLowerCase()).not.toMatch(/nothing (was|happened)/);
    }
    // And on the console's own half of the partial one, up to mark8ly's quote.
    expect(partial.slice(0, partial.indexOf("store-2")).toLowerCase()).not.toMatch(
      /nothing (was|happened)/,
    );
  });

  it("surfaces requires_reconciliation as its own fact, not as a failure", () => {
    const message = overrideMintedMessage("Acme Stores", "co_abc123", "live", RECONCILE);
    // Stripe moved and mark8ly could not record it. That is neither success
    // nor failure, and it is the one outcome an operator must chase by hand.
    expect(message).toMatch(/reconcil/i);
    expect(message).toContain("mark8ly");
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
  const repeating: OverrideForm = { ...COMPLETE, duration: "repeating", months: "3" };

  it("puts each field the seam names on that field's own input", () => {
    expect(overrideFieldPlacement("label", COMPLETE)).toBe("label");
    expect(overrideFieldPlacement("reason", COMPLETE)).toBe("reason");
    expect(overrideFieldPlacement("discount", COMPLETE)).toBe("discount");
    expect(overrideFieldPlacement("duration", COMPLETE)).toBe("duration");
    expect(overrideFieldPlacement("durationInMonths", repeating)).toBe("durationInMonths");
  });

  it("falls back to the form for a field name this dialog has no input for", () => {
    // A message that lands nowhere is indistinguishable, on screen, from a
    // request that succeeded.
    expect(overrideFieldPlacement(undefined, COMPLETE)).toBe("form");
    expect(overrideFieldPlacement("somethingTheSeamGrewLater", COMPLETE)).toBe("form");
  });

  it("falls back to the form for a KNOWN field whose input is not on screen", () => {
    // The months input exists only while `repeating` is chosen, and the seam
    // has a refusal for a month count on a discount that does not repeat — a
    // name the unknown-name fallback above would happily accept and then hang
    // on an input the operator cannot see.
    expect(overrideFieldPlacement("durationInMonths", { ...COMPLETE, duration: "once" })).toBe(
      "form",
    );
    expect(overrideFieldPlacement("durationInMonths", { ...COMPLETE, duration: "" })).toBe("form");
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
      attach: ALL_APPLIED,
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
      attach: ALL_APPLIED,
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      overrideMintedMessage("Acme Stores", "co_abc123", "live", ALL_APPLIED),
    );
    // THE TONE IS PART OF THE MESSAGE. This outcome is not a success in the
    // sense an operator means by the word, and the callout's colour is what
    // carries that to someone who skims the sentence. Asserted as the classes
    // `variant="warning"` produces because `@tesserix/web`'s barrel does not
    // export `calloutVariants` — so this breaks if the variant is dropped, and
    // also if the design system restyles it, which is the honest cost of the
    // only handle available.
    expect(notice).toHaveClass("border-accent", "bg-accent", "text-accent-foreground");
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
    // At form level, asserted by where it is NOT — the same reason its sibling
    // above checks these two: "the message appears somewhere" is satisfied
    // just as happily by pinning every refusal to one input.
    expect(screen.getByLabelText("Name on the tenant's invoice")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.getByLabelText("Why (internal)")).not.toHaveAttribute("aria-invalid");
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

/* ------------------------------------------------------------------------ *
 * What the operator is told after a retirement
 * ------------------------------------------------------------------------ */

describe("the retirement copy says what was retired and what is still discounted", () => {
  const clean = overrideRetiredMessage("Acme Stores", "co_abc123", "live", true, ALL_DETACHED);
  const undeleted = overrideRetiredMessage("Acme Stores", "co_abc123", "live", false, ALL_DETACHED);
  const partial = overrideRetiredMessage("Acme Stores", "co_abc123", "live", true, PARTIAL_DETACH);
  const unreported = overrideRetiredMessage(
    "Acme Stores",
    "co_abc123",
    "live",
    true,
    UNREPORTED_DETACH,
  );

  it("never claims a discount was cancelled or refunded", () => {
    // The words, not the sentence, exactly as before: the failure to guard
    // against is a friendlier rewrite that means something untrue. Taking a
    // coupon off a subscription is not a cancellation and refunds nothing.
    for (const forbidden of ["cancelled", "refunded", "revoked"]) {
      for (const message of [clean, undeleted, partial, unreported]) {
        expect(message.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("attributes the retirement to the override and the deletion to the coupon", () => {
    // BOTH ARMS, because the distinction is what the failed-delete arm depends
    // on: it has to be able to say the override was retired AND the coupon was
    // not deleted, in one sentence, without contradicting itself.
    for (const message of [clean, undeleted]) {
      expect(message).toMatch(/override was retired/);
      expect(message).toMatch(/coupon co_abc123 was (not )?deleted/);
    }
  });

  it("names the coupon as still live in Stripe, and where to look, when it was not deleted", () => {
    expect(undeleted).toContain("still live in the live Stripe account");
    expect(undeleted).toContain("Stripe dashboard");
    // And the deleted arm must NOT say it — one sentence covering both
    // outcomes would be false for one of them.
    expect(clean).not.toContain("still live");
  });

  it("says a corrected override can now be granted", () => {
    // The operator's actual next affordance, and the whole point of #581 —
    // 0047's partial unique index no longer counts a live row for this tenant.
    for (const message of [clean, undeleted, partial, unreported]) {
      expect(message).toContain("corrected override can now be granted");
    }
  });

  it("says mark8ly took the discount off, and from how many stores", () => {
    expect(clean).toMatch(/took it off all 2 of their stores/);
  });

  it("says PLAINLY that the tenant is still discounted when the detach did not happen", () => {
    // The sentence #331 exists for, inverted: an operator who believes a
    // revoke removed a discount that is still on the subscription will tell
    // the merchant they are back on list price.
    expect(unreported).toMatch(/still discounted/i);
    expect(unreported).toContain(UNREPORTED_DETACH.message);
  });

  it("names the stores that kept it, with mark8ly's own reason", () => {
    expect(partial).toMatch(/took it off 1 of 2 stores/);
    expect(partial).toContain("store-2");
    expect(partial).toContain("this store's subscription could not be read");
    expect(partial).toMatch(/still discounted/i);
  });

  it("does not say the tenant is still discounted when every store gave it back", () => {
    // Asserted by absence, because a warning that fires on every revoke is one
    // an operator stops reading before the revoke where it is true.
    for (const message of [clean, undeleted]) {
      expect(message.toLowerCase()).not.toContain("still discounted");
    }
  });

  it("never says nothing happened — the retirement did", () => {
    // `partial` is excluded for the mint block's reason: mark8ly's own
    // sentence for a store whose subscription could not be read says "nothing
    // was changed for it", about that store, and is quoted verbatim.
    for (const message of [clean, undeleted, unreported]) {
      expect(message.toLowerCase()).not.toMatch(/nothing (was|happened)/);
    }
    expect(partial.slice(0, partial.indexOf("store-2")).toLowerCase()).not.toMatch(
      /nothing (was|happened)/,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The pure function over the retire form
 * ------------------------------------------------------------------------ */

describe("nothing on the retire form is defaulted either", () => {
  it("ships an empty form with no mode and no reason", () => {
    expect(EMPTY_OVERRIDE_REVOKE_FORM.mode).toBe("");
    expect(EMPTY_OVERRIDE_REVOKE_FORM.reason).toBe("");
  });

  it("refuses to submit without a mode, and without a reason", () => {
    const complete = { ...EMPTY_OVERRIDE_REVOKE_FORM, mode: "live" as const, reason: "Mis-keyed." };
    expect(overrideRevokeSubmittable(complete)).toBe(true);
    expect(overrideRevokeSubmittable({ ...complete, mode: "" })).toBe(false);
    expect(overrideRevokeSubmittable({ ...complete, reason: "   " })).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The retire dialog
 * ------------------------------------------------------------------------ */

const RETIRE_REASON = "Minted against the wrong tenant.";

async function openRetireDialog(tenant: EstateTenant = TENANT) {
  const user = userEvent.setup();
  render(<TenantPricingOverrideAction tenant={tenant} />);
  await user.click(
    screen.getByRole("button", { name: `Retire pricing override for ${tenant.name}` }),
  );
  return user;
}

/** Fills the two controls the retire dialog has, through the UI. */
async function fillRetire(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Stripe account the override was minted in"), "live");
  await user.type(screen.getByLabelText("Why (internal)"), RETIRE_REASON);
}

describe("the retire dialog", () => {
  it("keeps the confirm button disabled until a mode and a reason are given", async () => {
    const user = await openRetireDialog();
    const confirm = screen.getByRole("button", { name: "Retire override" });
    expect(confirm).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Stripe account the override was minted in"),
      "live",
    );
    // A mode alone is not enough — the reason is mandatory, and the seam
    // refuses without it, so an enabled button here would only ever produce a
    // round trip and a refusal.
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Why (internal)"), RETIRE_REASON);
    expect(confirm).toBeEnabled();
  });

  it("sends the namespaced tenant id, the chosen mode and the reason", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      couponDeleted: true,
      detach: ALL_DETACHED,
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    expect(revokeTenantPricingOverrideAction).toHaveBeenCalledWith({
      tenantId: "mark8ly:42",
      mode: "live",
      reason: RETIRE_REASON,
    });
  });

  it("tells the operator what was retired, what can now be granted, and what mark8ly still owes", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      couponDeleted: true,
      detach: ALL_DETACHED,
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      overrideRetiredMessage("Acme Stores", "co_abc123", "live", true, ALL_DETACHED),
    );
    // The same warning tone the mint outcome carries, and for the same reason:
    // this is not a success in the sense an operator means by the word, and
    // the colour is what reaches someone who skims the sentence. Asserted as
    // the classes `variant="warning"` produces because `@tesserix/web`'s barrel
    // does not export `calloutVariants`.
    expect(notice).toHaveClass("border-accent", "bg-accent", "text-accent-foreground");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("warns that the coupon is still live in Stripe when the delete did not happen", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      couponDeleted: false,
      detach: ALL_DETACHED,
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      overrideRetiredMessage("Acme Stores", "co_abc123", "live", false, ALL_DETACHED),
    );
    // The two success shapes must not render the same sentence — one of them
    // would then be false, which is the whole reason the seam returns the flag.
    expect(notice).toHaveTextContent("still live in the live Stripe account");
  });
});

describe("when the retirement is refused", () => {
  it("shows the seam's own message, verbatim, at form level", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: false,
      message:
        "This tenant has no live pricing override in live mode, so nothing was retired.",
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This tenant has no live pricing override in live mode, so nothing was retired.",
    );
    // At form level, asserted by where it is NOT: pinning every refusal to the
    // reason box would tell an operator to fix a field that is fine.
    expect(screen.getByLabelText("Why (internal)")).not.toHaveAttribute("aria-invalid");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("attaches a refused reason to the reason box", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: false,
      message: "Say why this tenant's pricing override is being removed.",
      field: "reason",
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    const box = screen.getByLabelText("Why (internal)");
    expect(box).toHaveAttribute("aria-invalid", "true");
    const described = box.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described as string)).toHaveTextContent(
      "Say why this tenant's pricing override is being removed.",
    );
  });

  it("never claims nothing happened when the call itself failed", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockRejectedValue(new Error("offline"));
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(OVERRIDE_REVOKE_NOT_CONFIRMED);
    // The request may have arrived and retired the row before the response was
    // lost, so the message may not say it did not.
    expect(OVERRIDE_REVOKE_NOT_CONFIRMED.toLowerCase()).not.toContain("nothing");
    expect(refresh).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ *
 * The fan-out, on screen
 * ------------------------------------------------------------------------ */

describe("what a partial fan-out looks like to the operator", () => {
  it("puts the counts, the store that missed out and mark8ly's reason in the notice", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      attach: PARTIAL,
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    const notice = await screen.findByRole("status");
    // The rendered copy, not the function's return value — a message that
    // never reaches the callout is indistinguishable, on screen, from a
    // fan-out that fully succeeded.
    expect(notice).toHaveTextContent("applied it to 1 of 2 stores");
    expect(notice).toHaveTextContent("store-2");
    expect(notice).toHaveTextContent("the stripe call failed");
  });

  it("carries requires_reconciliation all the way to the notice", async () => {
    vi.mocked(grantTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      attach: RECONCILE,
    });
    const user = await openDialog();
    await fillComplete(user);
    await user.click(screen.getByRole("button", { name: "Mint coupon" }));

    // Stripe moved and mark8ly could not record it. It is not a failure and it
    // is not a success, and it is the one outcome nobody will chase unless the
    // console says so.
    expect(await screen.findByRole("status")).toHaveTextContent(/reconcil/i);
  });

  it("tells the operator the tenant is still discounted when the detach failed", async () => {
    vi.mocked(revokeTenantPricingOverrideAction).mockResolvedValue({
      ok: true,
      couponId: "co_abc123",
      couponDeleted: true,
      detach: UNREPORTED_DETACH,
    });
    const user = await openRetireDialog();
    await fillRetire(user);
    await user.click(screen.getByRole("button", { name: "Retire override" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/still discounted/i);
    // And it is still a success: the row is retired, so a correction is
    // grantable and there is nothing here to retry.
    expect(notice).toHaveTextContent("corrected override can now be granted");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ *
 * What each dialog says confirming will do
 * ------------------------------------------------------------------------ */

describe("the dialogs describe the whole operation, including the federated half", () => {
  // `consequence` and `revokeConsequence` are module-private and rendered as
  // each dialog's description. Nothing pinned them before T3, so both would
  // have gone on describing a console that could not apply what it minted.
  it("says the mint dialog will apply the coupon in mark8ly, per store", async () => {
    const user = await openDialog();
    await user.selectOptions(screen.getByLabelText("Stripe account"), "live");

    const description = screen.getByText(/A coupon with these terms will be created/);
    expect(description).toHaveTextContent("the live Stripe account");
    expect(description).toHaveTextContent("mark8ly");
    // The honest half: an attach can reach some stores and not others.
    expect(description).toHaveTextContent(/store/i);
    expect(description.textContent?.toLowerCase()).not.toContain("cannot yet apply");
  });

  it("says the retire dialog will ask mark8ly to take the discount off", async () => {
    const user = await openRetireDialog();
    await user.selectOptions(
      screen.getByLabelText("Stripe account the override was minted in"),
      "test",
    );

    const description = screen.getByText(/will be retired/);
    expect(description).toHaveTextContent("the test Stripe account");
    expect(description).toHaveTextContent("mark8ly");
    expect(description.textContent?.toLowerCase()).not.toContain("separate step in mark8ly");
  });
});
