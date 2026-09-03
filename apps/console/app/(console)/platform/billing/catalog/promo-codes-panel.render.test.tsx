import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

// `./promo-actions` reaches `promo-codes-repo.ts` and `stripe-write.ts` (both
// `server-only`, one of them `stripe`) — mocked so this suite exercises the
// CLIENT composition only, the discipline `authoring-panel.render.test.tsx`
// applies to `./actions`. `promo-actions.test.ts` covers the real actions,
// including what they SEND to Stripe.
const createPromoCodeAction = vi.fn();
const updatePromoCodeAction = vi.fn();
const deactivatePromoCodeAction = vi.fn();
const mintCouponAction = vi.fn();

vi.mock("./promo-actions", () => ({
  createPromoCodeAction: (...args: unknown[]) => createPromoCodeAction(...args),
  updatePromoCodeAction: (...args: unknown[]) => updatePromoCodeAction(...args),
  deactivatePromoCodeAction: (...args: unknown[]) => deactivatePromoCodeAction(...args),
  mintCouponAction: (...args: unknown[]) => mintCouponAction(...args),
}));

import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
import {
  PromoCodesPanel,
  REDEMPTIONS_UNREPORTED,
  describeTrialRepeatingConflict,
  type PromoCodeView,
} from "./promo-codes-panel";

const READY: SurfaceState = { kind: "ready" };

const DISCOUNT_CODE: PromoCodeView = {
  id: "promo-1",
  code: "LAUNCH50",
  trialExtensionDays: null,
  discount: { kind: "percent_off", percentOff: 50, duration: "repeating", durationInMonths: 3 },
  validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: null,
  maxRedemptions: 100,
  isActive: true,
  coupons: [],
};

const TRIAL_ONLY_CODE: PromoCodeView = {
  id: "promo-2",
  code: "EXTRA30",
  trialExtensionDays: 30,
  discount: null,
  validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: "2026-12-31T00:00:00.000Z",
  maxRedemptions: null,
  isActive: true,
  coupons: [],
};

function renderPanel(over: Partial<Parameters<typeof PromoCodesPanel>[0]> = {}) {
  return render(
    <PromoCodesPanel
      mode="test"
      codes={[DISCOUNT_CODE]}
      codesState={READY}
      canAuthor
      canMint
      {...over}
    />,
  );
}

/** The form is uncontrolled from the test's point of view — every field is a
 *  labelled input, so a test types the way an operator does. */
function type(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function pick(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  createPromoCodeAction.mockResolvedValue({ ok: true });
  updatePromoCodeAction.mockResolvedValue({ ok: true });
  deactivatePromoCodeAction.mockResolvedValue({ ok: true });
  mintCouponAction.mockResolvedValue({ ok: true });
});

/* ------------------------------------------------------------------------ *
 * Authoring
 * ------------------------------------------------------------------------ */

describe("authoring a definition", () => {
  it("sends the typed code and its effects, both of them", async () => {
    renderPanel();

    type("Code", "launch50");
    type(/Trial extension/, "30");
    pick("Discount", "percent_off");
    type("Percent off", "50");
    pick("Duration", "repeating");
    type("Months", "3");
    type(/Redemption cap/, "100");

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Author a promo code/ }));
    });

    // The REQUEST, not merely that a call happened: decision 2 is that both
    // effects stack on one code, and a form that dropped one of them would
    // still "succeed".
    expect(createPromoCodeAction).toHaveBeenCalledWith({
      code: "launch50",
      trialExtensionDays: 30,
      discount: {
        kind: "percent_off",
        percentOff: 50,
        duration: "repeating",
        durationInMonths: 3,
      },
      validFrom: null,
      validUntil: null,
      maxRedemptions: 100,
    });
  });

  it("sends an amount-off with its currency and no percent-off", async () => {
    renderPanel();

    type("Code", "TENOFF");
    pick("Discount", "amount_off");
    type(/Amount off/, "1000");
    type("Currency", "usd");

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Author a promo code/ }));
    });

    const [sent] = createPromoCodeAction.mock.calls[0] as [Record<string, unknown>];
    expect(sent.discount).toEqual({
      kind: "amount_off",
      amountOffMinor: 1000,
      currency: "usd",
      duration: "once",
      durationInMonths: null,
    });
    expect(sent.discount).not.toHaveProperty("percentOff");
  });

  it("shows the action's refusal verbatim and keeps what was typed", async () => {
    createPromoCodeAction.mockResolvedValue({
      ok: false,
      message: "That code already exists. Codes are stored upper-case, so LAUNCH50 and launch50 are the same code.",
    });
    renderPanel();

    type("Code", "LAUNCH50");
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Author a promo code/ }));
    });

    expect(screen.getByText(/That code already exists/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("LAUNCH50");
  });

  it("refuses a field that is not a number without calling the action", async () => {
    renderPanel();

    type("Code", "TYPO");
    type(/Trial extension/, "thirty");
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Author a promo code/ }));
    });

    expect(createPromoCodeAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a number/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Decision 3 — the warning
 * ------------------------------------------------------------------------ */

describe("the repeating-discount-meets-trial-extension warning", () => {
  it("fires when a repeating discount meets a trial extension, with the arithmetic", () => {
    renderPanel();

    type(/Trial extension/, "30");
    pick("Discount", "percent_off");
    type("Percent off", "50");
    pick("Duration", "repeating");
    type("Months", "3");

    const warning = screen.getByText(/Stripe starts a repeating discount at the first charge/);
    expect(warning).toHaveTextContent("adds 30 trial days");
    expect(warning).toHaveTextContent("3 discounted months");
    expect(warning).toHaveTextContent("30 days after the trial would otherwise have ended");
  });

  it("does not fire for a repeating discount with no trial extension", () => {
    renderPanel();

    pick("Discount", "percent_off");
    type("Percent off", "50");
    pick("Duration", "repeating");
    type("Months", "3");

    expect(screen.queryByText(/Stripe starts a repeating discount/)).toBeNull();
  });

  it("does not fire for a trial extension with a `once` or `forever` discount", () => {
    renderPanel();

    type(/Trial extension/, "30");
    pick("Discount", "percent_off");
    type("Percent off", "50");
    expect(screen.queryByText(/Stripe starts a repeating discount/)).toBeNull();

    pick("Duration", "forever");
    expect(screen.queryByText(/Stripe starts a repeating discount/)).toBeNull();
  });

  it("does not fire for a trial extension with no discount at all", () => {
    renderPanel();

    type(/Trial extension/, "30");
    expect(screen.queryByText(/Stripe starts a repeating discount/)).toBeNull();
  });

  it("allows the combination — the warning does not disable the submit", async () => {
    // Decision 3 is explicit that this is sometimes exactly what is wanted.
    renderPanel();

    type("Code", "LATER");
    type(/Trial extension/, "30");
    pick("Discount", "percent_off");
    type("Percent off", "50");
    pick("Duration", "repeating");
    type("Months", "3");

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Author a promo code/ }));
    });

    expect(createPromoCodeAction).toHaveBeenCalledTimes(1);
  });
});

describe("describeTrialRepeatingConflict", () => {
  it("is null unless BOTH a repeating discount and a positive trial extension are present", () => {
    const repeating = {
      kind: "percent_off",
      percentOff: 50,
      duration: "repeating",
      durationInMonths: 3,
    } as const;

    expect(describeTrialRepeatingConflict(null, repeating)).toBeNull();
    expect(describeTrialRepeatingConflict(0, repeating)).toBeNull();
    expect(describeTrialRepeatingConflict(30, null)).toBeNull();
    expect(
      describeTrialRepeatingConflict(30, { ...repeating, duration: "once", durationInMonths: null }),
    ).toBeNull();
    expect(describeTrialRepeatingConflict(30, repeating)).toContain("30 days later");
  });

  it("quotes no base trial length — mark8ly owns that number, not this console", () => {
    const said = describeTrialRepeatingConflict(30, {
      kind: "percent_off",
      percentOff: 50,
      duration: "repeating",
      durationInMonths: 3,
    });

    // A "begins on day 120" would be quoting a 90-day trial this codebase has
    // no source for. The delay is the operator's own number and is the part
    // that is true here.
    expect(said).not.toMatch(/\b(90|120)\b/);
  });
});

/* ------------------------------------------------------------------------ *
 * Immutable terms
 * ------------------------------------------------------------------------ */

describe("the discount terms cannot be amended, and the surface says where to go instead", () => {
  it("offers no discount control in the amend form, and says why", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    const form = screen.getByRole("form", { name: "Amend LAUNCH50" });

    expect(within(form).queryByLabelText(/Percent off/)).toBeNull();
    expect(within(form).queryByLabelText(/Duration/)).toBeNull();
    expect(within(form).getByText(/Discount terms cannot be amended/)).toBeInTheDocument();
    expect(within(form).getByText(/Replace this code/)).toBeInTheDocument();
  });

  it("sends only the amendable fields", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Amend" }));
    fireEvent.change(screen.getByLabelText("Trial days"), { target: { value: "14" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Amend LAUNCH50" }));
    });

    expect(updatePromoCodeAction).toHaveBeenCalledWith("promo-1", "LAUNCH50", {
      trialExtensionDays: 14,
      validFrom: "2026-09-01",
      validUntil: null,
      maxRedemptions: 100,
    });
  });

  it("loads the terms into a NEW definition when the operator replaces the code", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Replace this code" }));

    expect(screen.getByText("Replacing LAUNCH50")).toBeInTheDocument();
    // The terms are carried over so nothing has to be retyped...
    expect(screen.getByLabelText("Percent off")).toHaveValue("50");
    expect(screen.getByLabelText("Months")).toHaveValue("3");
    // ...and the code is NOT, because a replacement is a different code.
    expect(screen.getByLabelText("Code")).toHaveValue("");
  });
});

/* ------------------------------------------------------------------------ *
 * Retiring
 * ------------------------------------------------------------------------ */

describe("deactivating", () => {
  it("deactivates by id, and offers nothing to deactivate on a retired code", async () => {
    const { unmount } = renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    });
    expect(deactivatePromoCodeAction).toHaveBeenCalledWith("promo-1", "LAUNCH50");
    unmount();

    renderPanel({ codes: [{ ...DISCOUNT_CODE, isActive: false }] });
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Minting
 * ------------------------------------------------------------------------ */

describe("minting a coupon", () => {
  it("mints for the surface's mode, and names that mode on the control", async () => {
    renderPanel({ mode: "live" });

    const mint = screen.getByRole("button", { name: "Mint coupon in live" });
    await act(async () => {
      fireEvent.click(mint);
    });

    expect(mintCouponAction).toHaveBeenCalledWith("LAUNCH50", "live");
  });

  it("offers no mint for a trial-extension-only code — there is nothing to mint", () => {
    renderPanel({ codes: [TRIAL_ONLY_CODE] });

    expect(screen.queryByRole("button", { name: /Mint coupon/ })).toBeNull();
  });

  it("shows the minted id instead of the control once a mode is minted", () => {
    renderPanel({
      codes: [{ ...DISCOUNT_CODE, coupons: [{ mode: "test", stripeCouponId: "co_live1" }] }],
    });

    expect(screen.getByText(/test: co_live1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mint coupon in test/ })).toBeNull();
    // The OTHER mode is still mintable — a coupon is a per-mode fact.
  });

  it("surfaces a duplicate mint as a sentence, not a stack trace", async () => {
    mintCouponAction.mockResolvedValue({
      ok: false,
      message:
        "This code already has a coupon in that mode. The existing coupon is live and still redeemable, so a second one is not minted — to change the discount, author a new code and deactivate this one.",
    });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mint coupon in test" }));
    });

    expect(screen.getByText(/already has a coupon in that mode/)).toBeInTheDocument();
    expect(screen.queryByText(/pkey|duplicate key|Error:/)).toBeNull();
  });

  it("surfaces a missing write credential naming the mode, not a generic failure", async () => {
    mintCouponAction.mockResolvedValue({
      ok: false,
      message:
        "test mode has no usable Stripe write credential (STRIPE_WRITE_KEY_TEST is unset, or holds a key for the other account), so nothing was minted in test. The definition is saved and can be minted once the credential is in place.",
    });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mint coupon in test" }));
    });

    expect(screen.getByText(/STRIPE_WRITE_KEY_TEST/)).toBeInTheDocument();
    expect(screen.getByText(/test mode has no usable Stripe write credential/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Redemption counts — the absence
 * ------------------------------------------------------------------------ */

describe("redemption counts", () => {
  it("says they are not reported, and never renders a 0", () => {
    // A `0` would be a claim: that nobody has redeemed this code. mark8ly owns
    // that ledger and serves nothing to read it from, so the console has no
    // basis for either number.
    renderPanel({ codes: [DISCOUNT_CODE, TRIAL_ONLY_CODE] });

    const redeemed = screen.getAllByText(REDEMPTIONS_UNREPORTED);
    expect(redeemed).toHaveLength(2);
    expect(REDEMPTIONS_UNREPORTED).toMatch(/mark8ly/);

    for (const row of screen.getAllByRole("row").slice(1)) {
      const redeemedCell = within(row).getAllByRole("cell")[4];
      expect(redeemedCell).toHaveTextContent(REDEMPTIONS_UNREPORTED);
      expect(redeemedCell?.textContent?.trim()).not.toBe("0");
    }
  });

  it("shows the cap it does know, and says uncapped rather than 0 for an absent one", () => {
    renderPanel({ codes: [DISCOUNT_CODE, TRIAL_ONLY_CODE] });

    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("Uncapped")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Capability gating
 * ------------------------------------------------------------------------ */

describe("capability gating", () => {
  it("hides every authoring control without `billing`, and says the rows are still readable", () => {
    renderPanel({ canAuthor: false });

    expect(screen.queryByRole("form", { name: /Author a promo code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Amend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace this code" })).toBeNull();
    expect(screen.getByText(/needs the billing capability/)).toBeInTheDocument();
    // The definition itself is still on screen — this is a read-only view,
    // not a blocked page.
    expect(screen.getByText("LAUNCH50")).toBeInTheDocument();
  });

  it("hides minting without `publish-catalog` while authoring stays available", () => {
    // Independent checks, not nested: an operator with `billing` and without
    // `publish-catalog` authors definitions and mints nothing, which is
    // exactly what `promo-actions.ts` enforces server-side.
    renderPanel({ canMint: false });

    expect(screen.queryByRole("button", { name: /Mint coupon/ })).toBeNull();
    expect(screen.getByRole("form", { name: /Author a promo code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Amend" })).toBeInTheDocument();
  });

  it("offers minting without authoring when only `publish-catalog` is held", () => {
    renderPanel({ canAuthor: false, canMint: true });

    expect(screen.getByRole("button", { name: "Mint coupon in test" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /Author a promo code/ })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * The non-ready states
 * ------------------------------------------------------------------------ */

describe("the surface's own states", () => {
  it("renders no table at all when the read failed", () => {
    renderPanel({
      codes: [],
      codesState: resolveState({
        isLoading: false,
        error: { message: "We could not load promo codes." },
        rows: [],
        filtered: false,
      }),
    });

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/could not load promo codes/)).toBeInTheDocument();
  });

  it("says the surface is empty rather than showing a bare table", () => {
    renderPanel({
      codes: [],
      codesState: resolveState({ isLoading: false, error: null, rows: [], filtered: false }),
    });

    expect(screen.getByText(/No promo codes have been authored yet/)).toBeInTheDocument();
  });
});
