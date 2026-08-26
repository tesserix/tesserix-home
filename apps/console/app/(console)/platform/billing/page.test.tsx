import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/platform/billing",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { SubscriptionPage, TrialPage } from "@/lib/billing";
import { BILLING_UNAVAILABLE_TITLE, billingReadError, viewState } from "./page";
import { BillingViews, daysLabel, trialTone } from "./billing-views";

const subscription = {
  source: "mark8ly",
  tenantId: "t1",
  tenantName: "Acme",
  plan: "pro",
  status: "active",
  amount: { amount: 4900, currency: "AUD" },
  currentPeriodEnd: "2026-09-30T00:00:00Z",
  cancelAtPeriodEnd: false,
};

const trial = {
  source: "mark8ly",
  tenantId: "t3",
  tenantName: "Beta Co",
  trialEndsAt: "2026-09-10T00:00:00Z",
  daysRemaining: 2,
  plan: "pro",
  paymentMethodOnFile: false,
  status: "trialing",
  stripeManaged: false,
};

const subs = (over: Partial<SubscriptionPage> = {}): SubscriptionPage => ({
  data: [subscription],
  total: 37,
  failures: [],
  ...over,
});

const trials = (over: Partial<TrialPage> = {}): TrialPage => ({
  data: [trial],
  total: 5,
  failures: [],
  ...over,
});

function renderViews(over: Partial<Parameters<typeof BillingViews>[0]> = {}) {
  return render(
    <BillingViews
      subscriptions={subs()}
      trials={trials()}
      subscriptionsState={viewState({ error: null, rows: [subscription] })}
      trialsState={viewState({ error: null, rows: [trial] })}
      reauthReturnTo="/platform/billing"
      {...over}
    />,
  );
}

describe("a 501 is not an error", () => {
  // "No product federates billing" and "the estate has no customers" are
  // different claims, and only one of them is ever true here.
  it("renders config copy rather than the kit's observability default", () => {
    expect(billingReadError(new PlatformApiError("x", 501))?.unavailable?.title).toBe(
      BILLING_UNAVAILABLE_TITLE,
    );
  });

  it("leaves a real failure alone", () => {
    expect(billingReadError(new PlatformApiError("boom", 503))?.unavailable).toBeUndefined();
  });

  // A 403 here means the operator holds `platform` but not `billing`, which is
  // a real and intended outcome — it must not be dressed up as "not switched
  // on".
  it("does not disguise a capability refusal as a config gap", () => {
    expect(billingReadError(new PlatformApiError("forbidden", 403))?.unavailable).toBeUndefined();
  });
});

describe("daysLabel", () => {
  // 0 and 1 must not read as bugs, and a negative must not read as "-3 days".
  it("phrases the edges", () => {
    expect(daysLabel(0)).toBe("today");
    expect(daysLabel(1)).toBe("1 day");
    expect(daysLabel(9)).toBe("9 days");
    expect(daysLabel(-3)).toBe("ended");
  });
});

describe("trialTone", () => {
  // A trial with no payment method is the row somebody acts on.
  it("flags a trial with no payment method", () => {
    expect(trialTone(false)).toBe("warning");
    expect(trialTone(true)).toBe("neutral");
  });
});

describe("BillingViews", () => {
  // Trials first: it is the work queue. Subscriptions is a state view an
  // operator consults; a trial ending without a payment method is something
  // they do today.
  it("opens on trials, the work queue", () => {
    renderViews();
    expect(screen.getByText("Beta Co")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("shows how many of how many, since a page is not the whole book", () => {
    renderViews();
    expect(screen.getByText(/Showing 1 of 5 trials/)).toBeInTheDocument();
  });

  // A short revenue list reads as a small book of business. A product dropping
  // out of the fan-out turns that into an understatement nobody can see.
  it("warns when a source failed, and says the total understates", () => {
    renderViews({
      trials: trials({ failures: [{ source: "kora", message: "connection failed" }] }),
    });
    expect(screen.getByText(/view is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/understates/i)).toBeInTheDocument();
  });

  // One endpoint failing must not blank the other tab — they are separate
  // federated calls, settled independently.
  it("still renders trials when subscriptions failed entirely", () => {
    renderViews({
      subscriptions: { data: [], total: 0, failures: [] },
      subscriptionsState: viewState({ error: new PlatformApiError("boom", 503), rows: [] }),
    });
    expect(screen.getByText("Beta Co")).toBeInTheDocument();
  });
});
