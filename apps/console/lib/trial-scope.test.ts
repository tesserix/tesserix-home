import { describe, expect, it } from "vitest";
import {
  BILLING_PRODUCT_SOURCES,
  DEFAULT_TRIAL_WINDOW_DAYS,
  MAX_TRIAL_WINDOW_DAYS,
  TRIAL_STATUSES,
  TRIAL_STATUS_BOTH,
  TRIAL_STATUS_TRIALING,
  TRIAL_WINDOWS,
  isTrialStatusScope,
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
    // Relabelled when the widest scope began returning ended trials too: an
    // option saying "Any" while excluding them was the same invisible scope
    // this filter exists to remove. The "not every/all" guard below still
    // holds — the year bound is still a bound.
    expect(widest?.label).toBe("Any (up to a year, and ended)");
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

describe("the offered statuses", () => {
  // The two populations this list can hold, and neither is hidden by default.
  it("offers both populations and the narrowing, in that order", () => {
    expect(TRIAL_STATUSES.map((s) => s.value)).toEqual([
      TRIAL_STATUS_BOTH,
      TRIAL_STATUS_TRIALING,
    ]);
    expect(TRIAL_STATUSES[0]?.label).toBe("Trialing and signup");
    expect(TRIAL_STATUSES[1]?.label).toBe("Trialing only");
  });

  it("accepts only the statuses it offers", () => {
    expect(isTrialStatusScope("all")).toBe(true);
    expect(isTrialStatusScope("trialing")).toBe(true);
    expect(isTrialStatusScope("signup")).toBe(false);
    expect(isTrialStatusScope("")).toBe(false);
  });
});

describe("trialQueryFor", () => {
  // THE assertion that pins the decision. The console opts into signup rows on
  // first load, so the operator whose three tenants all sit at `signup` sees
  // them instead of an empty page. A tidy-up that restored the old
  // byte-identical default would restore that empty page with it.
  //
  // Still no `days`: the product's own 7-day window stays the single
  // definition, shared with its trials_expiring KPI.
  it("opts into signup rows by default, and still names no window", () => {
    expect(trialQueryFor({ days: DEFAULT_TRIAL_WINDOW_DAYS })).toEqual({
      includeSignup: true,
    });
    expect(trialQueryFor({ days: DEFAULT_TRIAL_WINDOW_DAYS }).days).toBeUndefined();
  });

  // The narrowing is the only thing that drops the opt-in — the API has no
  // "exclude" to send, so `Trialing only` is the absence of the flag.
  it("drops the opt-in when narrowed to Trialing only", () => {
    expect(trialQueryFor({ days: DEFAULT_TRIAL_WINDOW_DAYS, status: TRIAL_STATUS_TRIALING }))
      .toEqual({});
    expect(trialQueryFor({ days: 30, status: TRIAL_STATUS_TRIALING })).toEqual({ days: 30 });
  });

  it("keeps the opt-in when the wider status is named explicitly", () => {
    expect(trialQueryFor({ days: DEFAULT_TRIAL_WINDOW_DAYS, status: TRIAL_STATUS_BOTH })).toEqual({
      includeSignup: true,
    });
  });

  it("names a widened window", () => {
    expect(trialQueryFor({ days: 30 })).toEqual({ days: 30, includeSignup: true });
  });

  // THE coupling. A converting trial is still a trial: offering "Any" while
  // silently excluding Stripe-managed rows would rebuild the same
  // invisible-scope bug one level down. The two travel together.
  it("opts Stripe-managed trials in with the widest window, always", () => {
    expect(trialQueryFor({ days: MAX_TRIAL_WINDOW_DAYS })).toEqual({
      days: MAX_TRIAL_WINDOW_DAYS,
      includeStripeManaged: true,
      includeSignup: true,
      includeEnded: true,
    });
  });

  // The same coupling, for the widening no window can express. Every `days`
  // value looks FORWARD, so a trial that ended yesterday is absent from all
  // three — including the one labelled "Any". The rows it hid are the ones
  // that matter most: a trial still trialing days after its end means the
  // product's expiry sweep has stopped.
  it("opts ended trials in with the widest window, always", () => {
    expect(trialQueryFor({ days: MAX_TRIAL_WINDOW_DAYS }).includeEnded).toBe(true);
  });

  it("does not opt ended trials in at a narrower window", () => {
    expect(trialQueryFor({ days: 30 }).includeEnded).toBeUndefined();
    expect(trialQueryFor({ days: 7 }).includeEnded).toBeUndefined();
  });

  it("does not opt them in at a narrower window", () => {
    expect(trialQueryFor({ days: 30 }).includeStripeManaged).toBeUndefined();
    expect(trialQueryFor({ days: 7 }).includeStripeManaged).toBeUndefined();
  });

  it("narrows to one product when one was chosen", () => {
    expect(trialQueryFor({ days: 7, source: "mark8ly" })).toEqual({
      source: "mark8ly",
      includeSignup: true,
    });
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

  // Two reasons for an empty list, and they call for different actions. With
  // signup rows in by default, "nothing here" under `Trialing only` most
  // often means the tenants are one filter away, not that the window is
  // narrow.
  it("blames the status narrowing rather than the window, when narrowed", () => {
    const message = trialsEmptyMessage({ days: 7, status: TRIAL_STATUS_TRIALING });
    expect(message).toContain("completed checkout");
    expect(message).toContain("Trialing and signup");
    expect(message).toContain("that answered");
    expect(message).not.toMatch(/wider/i);
  });

  // The window is still applied under the narrowing, so it is still named —
  // hiding it would rebuild the invisible scope one filter along.
  it("still names the window it is empty of while narrowed", () => {
    expect(trialsEmptyMessage({ days: 30, status: TRIAL_STATUS_TRIALING })).toContain(
      "next 30 days",
    );
  });

  // The default scope keeps the copy it had: both populations are in, so the
  // window is the only thing narrowing the answer.
  it("blames the window when both populations are in", () => {
    const message = trialsEmptyMessage({ days: 7, status: TRIAL_STATUS_BOTH });
    expect(message).toContain("No trials expiring in the next 7 days");
    expect(message).toMatch(/wider/i);
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
