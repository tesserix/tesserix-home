import { describe, expect, it } from "vitest";
import {
  BILLING_PRODUCT_SOURCES,
  DEFAULT_TRIAL_WINDOW_DAYS,
  MAX_TRIAL_WINDOW_DAYS,
  TRIAL_WINDOWS,
  isTrialWindow,
  trialQueryFor,
  trialsEmptyMessage,
} from "./trial-scope";

describe("the offered windows", () => {
  // The landing state is the work queue, and it is the same 7 days the
  // product's own trials_expiring KPI counts. A different default here would
  // make the tab and the counter disagree about the word "expiring".
  it("opens on the product's own default", () => {
    expect(DEFAULT_TRIAL_WINDOW_DAYS).toBe(7);
    expect(TRIAL_WINDOWS[0]?.value).toBe("7");
    expect(TRIAL_WINDOWS[0]?.label).toBe("Next 7 days");
  });

  // The widest window is 365 days because that is what the product clamps to.
  // An operator-extended trial can end beyond a year, so copy promising "all"
  // or "every" trial would be a claim this filter cannot keep.
  it("labels the widest window without promising every trial", () => {
    const widest = TRIAL_WINDOWS.find((w) => w.value === String(MAX_TRIAL_WINDOW_DAYS));
    expect(widest).toBeDefined();
    expect(widest?.label).toBe("Any (up to a year)");
    for (const window of TRIAL_WINDOWS) {
      expect(window.label).not.toMatch(/\b(all|every)\b/i);
    }
  });

  it("accepts only the windows it offers", () => {
    expect(isTrialWindow("30")).toBe(true);
    expect(isTrialWindow("31")).toBe(false);
    expect(isTrialWindow("")).toBe(false);
  });
});

describe("trialQueryFor", () => {
  // Today's production request, byte for byte: no `days`, no opt-in. The
  // product applies its own 7-day default, which stays the single definition.
  it("sends nothing at all for the default window", () => {
    expect(trialQueryFor({ days: DEFAULT_TRIAL_WINDOW_DAYS })).toEqual({});
  });

  it("names a widened window", () => {
    expect(trialQueryFor({ days: 30 })).toEqual({ days: 30 });
  });

  // THE coupling. A converting trial is still a trial: offering "Any" while
  // silently excluding Stripe-managed rows would rebuild the same
  // invisible-scope bug one level down. The two travel together.
  it("opts Stripe-managed trials in with the widest window, always", () => {
    expect(trialQueryFor({ days: MAX_TRIAL_WINDOW_DAYS })).toEqual({
      days: MAX_TRIAL_WINDOW_DAYS,
      includeStripeManaged: true,
    });
  });

  it("does not opt them in at a narrower window", () => {
    expect(trialQueryFor({ days: 30 }).includeStripeManaged).toBeUndefined();
    expect(trialQueryFor({ days: 7 }).includeStripeManaged).toBeUndefined();
  });

  it("narrows to one product when one was chosen", () => {
    expect(trialQueryFor({ days: 7, source: "mark8ly" })).toEqual({ source: "mark8ly" });
  });
});

describe("trialsEmptyMessage", () => {
  // The sentence that would have answered the original report instantly: the
  // list was right, its scope was invisible.
  it("names the active window", () => {
    expect(trialsEmptyMessage({ days: 7 })).toContain("next 7 days");
    expect(trialsEmptyMessage({ days: 30 })).toContain("next 30 days");
  });

  // "a product did not answer" and "there are none" are different claims, and
  // `failures` renders alongside this. The clause is what keeps them apart.
  it("keeps the clause that distinguishes silence from absence", () => {
    expect(trialsEmptyMessage({ days: 7 })).toContain("that answered");
  });

  it("says a wider window exists, while one does", () => {
    expect(trialsEmptyMessage({ days: 7 })).toMatch(/wider/i);
    expect(trialsEmptyMessage({ days: 30 })).toMatch(/wider/i);
  });

  // At the widest window there is no wider one to offer, and claiming "no
  // trials at all" would be false — an extended trial can end past a year.
  it("neither offers a wider window nor claims there are none anywhere", () => {
    const message = trialsEmptyMessage({ days: MAX_TRIAL_WINDOW_DAYS });
    expect(message).toContain("next year");
    expect(message).not.toMatch(/wider/i);
    expect(message).toMatch(/past a year/i);
  });

  it("names the product when the view is narrowed to one", () => {
    expect(trialsEmptyMessage({ days: 7, sourceLabel: "Mark8ly" })).toContain("at Mark8ly");
  });
});

describe("the product options", () => {
  // Hardcoded rather than derived from ESTATE, and the direction is the
  // honest one: platform-api refuses an unknown source with a 400, so
  // offering a product that does not federate billing would turn a filter
  // choice into an error page.
  it("offers only products that federate billing today", () => {
    expect([...BILLING_PRODUCT_SOURCES]).toEqual(["mark8ly"]);
  });
});
