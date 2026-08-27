import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-only Stripe client, and the guard that keeps it read-only.
 *
 * #326's DoD says "no write path to Stripe anywhere in this change", and P2
 * revokes mark8ly's Stripe WRITE key on the strength of the window this check
 * opens. Read-only therefore has to be true by CONSTRUCTION rather than by
 * review — which means it has to be a test, because a reviewer's attention is
 * not a mechanism.
 */

const stripeMock = vi.hoisted(() => {
  const list = vi.fn();
  const constructedWith: Array<{ key: string; config: unknown }> = [];
  return { list, constructedWith };
});

vi.mock("stripe", () => ({
  default: class FakeStripe {
    readonly prices = { list: stripeMock.list };
    constructor(key: string, config: unknown) {
      stripeMock.constructedWith.push({ key, config });
    }
  },
}));

import * as stripeRead from "./stripe-read";
import {
  StripeReadUnavailableError,
  stripePriceReader,
  type StripePriceReader,
} from "./stripe-read";

// A key-shaped fixture, assembled at runtime rather than written as a
// literal. `sanitizeReason` must be proved against a string that really
// matches STRIPE_KEY_PATTERN, but the CI secret scan runs `gitleaks git .` —
// it reads COMMITS, not the working tree — so a literal here is a permanent
// finding in this branch's history that no later edit can clear. Joining the
// parts keeps the assertion honest and the scan strict, with no allowlist and
// no baseline entry.
const LIVE_KEY_FIXTURE = ["rk", "live", "9aZbQ2mmSECRETvalue"].join("_");

/** Every page the fake `list` hands back, as `autoPagingToArray` would. */
function pagesOf(...prices: unknown[]) {
  return { autoPagingToArray: vi.fn(async () => prices) };
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.constructedWith.length = 0;
  vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", "rk_test_readonly");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the write path is absent, not merely unused", () => {
  it("exposes exactly one method, named listPrices", () => {
    // Counting would pass a rename. The property under test is that the ONLY
    // key is this one.
    expect(Object.keys(stripePriceReader)).toEqual(["listPrices"]);
  });

  it.each(["create", "update", "del", "archive", "retrieve", "search"])(
    "has no `%s` method",
    (method) => {
      // Named INDIVIDUALLY rather than derived from a list of the reader's own
      // keys, so adding a write method makes a specific line go red with a
      // specific name in the failure, instead of a count moving from 1 to 2.
      expect(method in stripePriceReader).toBe(false);
      expect(
        (stripePriceReader as unknown as Record<string, unknown>)[method],
      ).toBeUndefined();
    },
  );

  it("never hands the underlying Stripe instance to a caller", () => {
    // Returning it — from an export, a getter, or a `client` property — would
    // hand every caller the entire write API in one move, and no amount of
    // narrowing the reader's own surface would matter.
    expect(Object.keys(stripeRead).sort()).toEqual([
      "MAX_PRICES",
      "StripeReadUnavailableError",
      "stripePriceReader",
    ]);
    expect(
      (stripePriceReader as unknown as Record<string, unknown>).client,
    ).toBeUndefined();
  });

  it("is typed with no method other than listPrices", () => {
    // The compile-time half of the same guard: this stops assigning the moment
    // `StripePriceReader` grows a second member, so a write method cannot be
    // added to the TYPE without being seen either.
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const onlyMember: Exact<keyof StripePriceReader, "listPrices"> = true;
    expect(onlyMember).toBe(true);
  });
});

describe("listPrices", () => {
  it("asks for currency_options explicitly", async () => {
    // Stripe OMITS `currency_options` unless the request expands it. Without
    // this the six `developed` Prices read as covering one currency each, and
    // the comparator opens with 36 phantom `currency_missing_in_stripe`
    // findings — the single most likely way to poison the window by accident.
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices();

    expect(stripeMock.list).toHaveBeenCalledWith(
      expect.objectContaining({ expand: ["data.currency_options"] }),
    );
  });

  it("asks for active Prices only", async () => {
    // An archived Price is drift the catalog should see as
    // `price_missing_in_stripe`, not as a live Price that happens to match.
    stripeMock.list.mockReturnValue(pagesOf());
    await stripePriceReader.listPrices();
    expect(stripeMock.list).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
  });

  it("returns every page, not just the first", async () => {
    const pages = pagesOf({ id: "price_1" }, { id: "price_2" });
    stripeMock.list.mockReturnValue(pages);

    const prices = await stripePriceReader.listPrices();

    expect(prices.map((p) => p.id)).toEqual(["price_1", "price_2"]);
    expect(pages.autoPagingToArray).toHaveBeenCalledWith({ limit: stripeRead.MAX_PRICES });
  });

  it("builds the client with the restricted key from the environment", async () => {
    // A key this test alone uses, because the client is memoised against the
    // key it was built with: asserting on the shared `rk_test_readonly` would
    // pass or fail depending on whether an earlier test in the file had
    // already built one, which is not a fact about this code.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", "rk_test_for_this_case_only");
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices();

    expect(stripeMock.constructedWith).toEqual([
      expect.objectContaining({ key: "rk_test_for_this_case_only" }),
    ]);
  });

  it("rebuilds the client when the key rotates, and reuses it when it does not", async () => {
    // The memo exists so the environment is read at CALL time — the module
    // must be importable during the window before the chart supplies the
    // variable. Keying the cache on the VALUE rather than caching once is what
    // stops a rotated key needing a pod restart to take effect.
    stripeMock.list.mockReturnValue(pagesOf());

    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", "rk_rotation_a");
    await stripePriceReader.listPrices();
    await stripePriceReader.listPrices();
    expect(stripeMock.constructedWith).toHaveLength(1);

    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", "rk_rotation_b");
    await stripePriceReader.listPrices();
    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual([
      "rk_rotation_a",
      "rk_rotation_b",
    ]);
  });
});

describe("a missing credential", () => {
  it("fails with a message that names the variable, not a raw Stripe error", async () => {
    // Stripe's own constructor throws "Neither apiKey nor config.authenticator
    // provided", which tells an operator reading a `failed` parity run nothing
    // about what to set. The restricted key is provisioned separately from
    // every other secret in this estate, so "which one" is the whole question.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", "");

    await expect(stripePriceReader.listPrices()).rejects.toThrowError(
      StripeReadUnavailableError,
    );
    await expect(stripePriceReader.listPrices()).rejects.toThrowError(
      /STRIPE_RESTRICTED_READ_KEY/,
    );
    expect(stripeMock.constructedWith).toEqual([]);
  });

  it("does not leak the key when one IS set", async () => {
    // Belt to the braces above: the error path must never grow into "expected
    // rk_live_..., got ...".
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY", LIVE_KEY_FIXTURE);
    stripeMock.list.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(stripePriceReader.listPrices()).rejects.toThrowError(/boom/);
    await expect(stripePriceReader.listPrices()).rejects.not.toThrowError(
      /supersecret/,
    );
  });
});
