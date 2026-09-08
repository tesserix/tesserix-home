import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Held rather than inlined: the filter tests assert the ONE navigation a
// filter change makes, which is how the scope reaches the server component
// that re-fetches.
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/platform/billing",
  useSearchParams: () => new URLSearchParams(),
}));

import { fireEvent } from "@testing-library/react";
import { PlatformApiError } from "@/lib/platform-api";
import {
  DEFAULT_TRIAL_WINDOW_DAYS,
  MAX_TRIAL_WINDOW_DAYS,
  TRIAL_STATUS_TRIALING,
  trialsEmptyMessage,
  type TrialStatusScope,
} from "@/lib/trial-scope";
import type { SubscriptionPage, TrialPage } from "@/lib/billing";
import {
  BILLING_UNAVAILABLE_TITLE,
  TRIAL_FILTERS,
  billingReadError,
  readTrialScope,
  toTrialFilterValues,
  viewState,
} from "./page";
import { BillingViews, daysLabel, trialEndDate, endsIsNotional, trialTone } from "./billing-views";

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

/**
 * A tenant that signed up and never completed checkout.
 *
 * `status: "signup"` is where mark8ly's Bootstrap leaves every subscription,
 * and only a completed Stripe checkout moves it on — so this row is not an
 * edge case, it is the state an abandoned signup stays in forever.
 */
const signupTrial = {
  ...trial,
  tenantId: "t4",
  tenantName: "Gamma Ltd",
  status: "signup",
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
      trialFilters={TRIAL_FILTERS}
      trialFilterValues={toTrialFilterValues({ days: DEFAULT_TRIAL_WINDOW_DAYS })}
      trialsEmptyMessage={trialsEmptyMessage({ days: DEFAULT_TRIAL_WINDOW_DAYS })}
      {...over}
    />,
  );
}

/** An empty trials tab: no rows, no error — the state the original report
 *  was looking at. */
function renderEmptyTrials(
  scope: { days: number; status?: TrialStatusScope; sourceLabel?: string },
  over = {},
) {
  return renderViews({
    trials: trials({ data: [], total: 0, ...over }),
    trialsState: viewState({ error: null, rows: [] }),
    trialFilterValues: toTrialFilterValues({ days: scope.days, status: scope.status }),
    trialsEmptyMessage: trialsEmptyMessage(scope),
  });
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
  });

  // Was `expect(daysLabel(-3)).toBe("ended")`. The widest scope now returns
  // trials that have already ended, so this is a row an operator judges rather
  // than an edge case — and "ended" alone gives them nothing to judge with.
  // One that ended yesterday and one that ended six weeks ago mean very
  // different things; the second means the product's expiry sweep stopped.
  it("says how long ago a trial ended", () => {
    expect(daysLabel(-1)).toBe("ended yesterday");
    expect(daysLabel(-3)).toBe("ended 3 days ago");
    expect(daysLabel(-42)).toBe("ended 42 days ago");
  });

  it("never renders a bare negative", () => {
    for (const days of [-1, -3, -42, -365]) {
      expect(daysLabel(days)).not.toContain("-");
    }
  });
});

describe("trialEndDate", () => {
  it("states the date, so the relative label is never the only answer", () => {
    expect(trialEndDate("2026-07-28T00:00:00Z")).toMatch(/2026/);
  });

  // The value crosses federation from another product; a malformed one is a
  // row to notice, not a cell rendering "Invalid Date".
  it("degrades to a dash rather than Invalid Date", () => {
    expect(trialEndDate("not-a-date")).toBe("—");
  });
});

describe("trialTone", () => {
  // A trial with no payment method is the row somebody acts on.
  it("flags a trial with no payment method", () => {
    expect(trialTone(false)).toBe("warning");
    expect(trialTone(true)).toBe("neutral");
  });
});

describe("endsIsNotional", () => {
  // A `signup` row's trial_ends_at is derived from created_at + 90d and no
  // expiry job ever acts on it, so the date is a projection rather than a
  // deadline. A `trialing` row's is the real one.
  it("marks a signup row's end date as derived, and a trialing row's as real", () => {
    expect(endsIsNotional("signup")).toBe(true);
    expect(endsIsNotional("trialing")).toBe(false);
  });
});

describe("the two trial populations on screen", () => {
  function renderBoth() {
    return renderViews({
      trials: trials({ data: [trial, signupTrial], total: 2 }),
      trialsState: viewState({ error: null, rows: [trial, signupTrial] }),
    });
  }

  // The status has been parsed since §8.2 landed and never rendered. The two
  // populations need different actions — chase a signup to finish checkout,
  // chase a trialing tenant for a card — so an undifferentiated list would
  // trade one invisible scope for another.
  it("renders each row's status in the product's own words", () => {
    renderBoth();
    expect(screen.getByText("trialing")).toBeInTheDocument();
    expect(screen.getByText("signup")).toBeInTheDocument();
  });

  // A date that looks like an enforced deadline when nothing enforces it is
  // worse than no date.
  it("qualifies the signup row's end date and leaves the trialing one alone", () => {
    renderBoth();
    const signupRow = screen.getByText("Gamma Ltd").closest("tr");
    const trialingRow = screen.getByText("Beta Co").closest("tr");
    expect(signupRow).toHaveTextContent(/notional/i);
    expect(trialingRow).not.toHaveTextContent(/notional/i);
  });

  // `<time dateTime=…>` states a machine-readable instant. A notional date is
  // not one, so the signup row does not make that claim.
  it("does not publish the notional date as a machine-readable time", () => {
    renderBoth();
    const signupRow = screen.getByText("Gamma Ltd").closest("tr");
    const trialingRow = screen.getByText("Beta Co").closest("tr");
    expect(signupRow?.querySelector("time")).toBeNull();
    expect(trialingRow?.querySelector("time")).not.toBeNull();
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

/**
 * Reading the scope out of the URL.
 *
 * A query string is untrusted input, so a value only survives if it is one the
 * surface actually offers — anything else is dropped and the default applies.
 * Forwarding an unrecognised window would either be clamped by the platform
 * boundary or refused, and either way the bar would display a scope that is
 * not the one in effect.
 */
describe("readTrialScope", () => {
  it("lands on the work queue when the URL says nothing", () => {
    expect(readTrialScope({})).toEqual({ days: DEFAULT_TRIAL_WINDOW_DAYS });
  });

  it("honours the windows it offers", () => {
    expect(readTrialScope({ days: "30" }).days).toBe(30);
    expect(readTrialScope({ days: "365" }).days).toBe(MAX_TRIAL_WINDOW_DAYS);
  });

  it("falls back to the default for a window it does not offer", () => {
    expect(readTrialScope({ days: "abc" }).days).toBe(DEFAULT_TRIAL_WINDOW_DAYS);
    expect(readTrialScope({ days: "1000" }).days).toBe(DEFAULT_TRIAL_WINDOW_DAYS);
    // Repeated params arrive as an array; the endpoint takes one value.
    expect(readTrialScope({ days: ["7", "30"] }).days).toBe(DEFAULT_TRIAL_WINDOW_DAYS);
  });

  // Absent means both populations — the widest scope this surface asks for,
  // so an absent value narrows nothing and there is no invisible scope to
  // record. Only the narrowing is written down.
  it("records the status narrowing and nothing else", () => {
    expect(readTrialScope({ status: "trialing" })).toEqual({
      days: DEFAULT_TRIAL_WINDOW_DAYS,
      status: TRIAL_STATUS_TRIALING,
    });
    expect(readTrialScope({ status: "all" }).status).toBeUndefined();
    expect(readTrialScope({ status: "signup" }).status).toBeUndefined();
    expect(readTrialScope({ status: ["trialing", "all"] }).status).toBeUndefined();
  });

  it("keeps a product that federates billing and drops one that does not", () => {
    expect(readTrialScope({ source: "mark8ly" }).source).toBe("mark8ly");
    // platform-api answers 400 for a source it cannot call, so an invented one
    // would turn a deep link into an error page.
    expect(readTrialScope({ source: "devai" }).source).toBeUndefined();
  });
});

describe("the trials scope on screen", () => {
  beforeEach(() => {
    replace.mockReset();
  });

  /** The query of the single navigation the interaction produced. */
  function pushedParams(): URLSearchParams {
    expect(replace).toHaveBeenCalledTimes(1);
    const url = replace.mock.calls[0][0] as string;
    return new URLSearchParams(url.slice(url.indexOf("?") + 1));
  }

  // The scope was always applied; only its invisibility was the bug.
  it("shows the active window, defaulting to the work queue", () => {
    renderViews();
    expect(screen.getByLabelText("Expiring")).toHaveTextContent("Next 7 days");
  });

  // The URL is what the server component re-reads, so this navigation IS the
  // re-fetch with `days`.
  it("puts a widened window in the URL", () => {
    renderViews();
    fireEvent.click(screen.getByLabelText("Expiring"));
    fireEvent.click(screen.getByRole("option", { name: "Next 30 days" }));
    expect(pushedParams().get("days")).toBe("30");
  });

  it("puts the chosen product in the URL under the API's own parameter name", () => {
    renderViews();
    fireEvent.click(screen.getByLabelText("Product"));
    fireEvent.click(screen.getByRole("option", { name: "Mark8ly" }));
    expect(pushedParams().get("source")).toBe("mark8ly");
  });

  // The default is a SELECTION and renders as one. It is also the widening
  // one: the tab lands showing both populations, which is the whole fix.
  it("shows both populations as the selected status", () => {
    renderViews();
    expect(screen.getByLabelText("Status")).toHaveTextContent("Trialing and signup");
  });

  it("puts the status narrowing in the URL", () => {
    renderViews();
    fireEvent.click(screen.getByLabelText("Status"));
    fireEvent.click(screen.getByRole("option", { name: "Trialing only" }));
    expect(pushedParams().get("status")).toBe(TRIAL_STATUS_TRIALING);
  });

  // There is no "All statuses" to offer: the widest scope this list has is
  // already the default, and an option that could only clear the param and
  // land back on it is one the surface cannot honour.
  it("offers no unhonourable All option beside the two statuses", () => {
    renderViews();
    fireEvent.click(screen.getByLabelText("Status"));
    expect(screen.getByRole("option", { name: "Trialing and signup" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Trialing only" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^All /i })).toBeNull();
  });

  // The label must not promise what the window cannot deliver: 365 days is a
  // bound, and an extended trial can end past it.
  it("does not offer a window that claims every trial", () => {
    renderViews();
    fireEvent.click(screen.getByLabelText("Expiring"));
    // Relabelled: the widest scope now also returns ended trials, and an
    // option claiming "Any" while excluding them was the same invisible
    // scope this filter exists to fix.
    expect(
      screen.getByRole("option", { name: "Any (up to a year, and ended)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^All /i })).toBeNull();
  });
});

/**
 * The empty state is the deliverable. "Nothing here yet" over a silently
 * 7-day-scoped list is what sent an operator looking for a bug that was not
 * there.
 */
describe("the empty trials tab", () => {
  it("names the window it is empty of", () => {
    renderEmptyTrials({ days: DEFAULT_TRIAL_WINDOW_DAYS });
    expect(screen.getByText(/No trials expiring in the next 7 days/)).toBeInTheDocument();
  });

  it("still distinguishes 'none' from 'a product did not answer'", () => {
    renderEmptyTrials({ days: DEFAULT_TRIAL_WINDOW_DAYS });
    expect(screen.getByText(/that answered/)).toBeInTheDocument();
  });

  // Without the bar the sentence is a dead end: the operator is told the scope
  // and given no way to change it.
  it("keeps the filters reachable, so the window can be widened from here", () => {
    renderEmptyTrials({ days: DEFAULT_TRIAL_WINDOW_DAYS });
    expect(screen.getByLabelText("Expiring")).toBeInTheDocument();
  });

  // Two reasons for an empty list, and only one of them is the window. With
  // signup rows in by default, an empty `Trialing only` list usually means
  // the tenants are one filter away.
  it("names the status narrowing rather than the window, when narrowed", () => {
    renderEmptyTrials({ days: DEFAULT_TRIAL_WINDOW_DAYS, status: TRIAL_STATUS_TRIALING });
    expect(screen.getByText(/completed checkout/)).toBeInTheDocument();
    expect(screen.getByText(/Trialing and signup/)).toBeInTheDocument();
  });

  // `failures` renders above the list, empty or not: "no trials in this
  // window" and "a product could not be read" are both true at once here, and
  // the second is what makes the first partial.
  it("shows the incomplete-view warning alongside", () => {
    renderEmptyTrials(
      { days: DEFAULT_TRIAL_WINDOW_DAYS },
      { failures: [{ source: "kora", message: "connection failed" }] },
    );
    expect(screen.getByText(/view is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/No trials expiring in the next 7 days/)).toBeInTheDocument();
  });
});
