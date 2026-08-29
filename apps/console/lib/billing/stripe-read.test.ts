import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-only Stripe client, and the guard that keeps it read-only.
 *
 * #326's DoD says "no write path to Stripe anywhere in this change", and P2
 * revokes mark8ly's Stripe WRITE key on the strength of the window this check
 * opens. Read-only therefore has to be true by CONSTRUCTION rather than by
 * review — which means it has to be a test, because a reviewer's attention is
 * not a mechanism.
 *
 * # Two modes, two credentials, and no coupling between them
 *
 * The check now covers test AND live, and the two are as independent as this
 * module can make them. A missing live key must give the LIVE run a `failed`
 * row and leave the test run untouched; a rotated test key must not disturb
 * live's memoised client. Anything less and one absent secret takes the whole
 * window down, which is the failure that leaves seven day-shaped holes rather
 * than one.
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
  STRIPE_MODES,
  StripeReadUnavailableError,
  stripePriceReader,
  type StripeMode,
  type StripePriceReader,
} from "./stripe-read";

// Key-shaped fixtures, assembled at runtime rather than written as literals.
// The mode-mismatch guard must be proved against strings that really carry a
// Stripe prefix, but the CI secret scan runs `gitleaks git .` — it reads
// COMMITS, not the working tree — so a literal here is a permanent finding in
// this branch's history that no later edit can clear. Joining the parts keeps
// the assertions honest and the scan strict, with no allowlist and no baseline
// entry.
const LIVE_KEY_FIXTURE = ["rk", "live", "9aZbQ2mmSECRETvalue"].join("_");
const TEST_KEY_FIXTURE = ["rk", "test", "9aZbQ2mmSECRETvalue"].join("_");

/** Every page the fake `list` hands back, as `autoPagingToArray` would. */
function pagesOf(...prices: unknown[]) {
  return { autoPagingToArray: vi.fn(async () => prices) };
}

/** A key that is unmistakably this test's, so an assertion on the memo is
 *  about this code and not about whether an earlier case already built one. */
const uniqueKey = (mode: StripeMode, tag: string) => `rk_${mode}_${tag}`;

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.constructedWith.length = 0;
  vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", "rk_test_readonly");
  vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", "rk_live_readonly");
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
    // `isStripeReadUnavailable` earns its place on this list the way every
    // entry has to: it is a pure predicate over a caught value, holds no
    // credential, reaches nothing, and hands back a boolean. It exists so a
    // CALLER (`orphansReadError`, the plan catalog page) can tell "Stripe was
    // never reached and no retry will change that" apart from a genuine
    // failure without importing the error class into a worse position.
    expect(Object.keys(stripeRead).sort()).toEqual([
      "KEY_ENV",
      "MAX_PRICES",
      "STRIPE_MODES",
      "StripeReadUnavailableError",
      "isStripeReadUnavailable",
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

describe("the two modes", () => {
  it("names exactly test and live, in that order", () => {
    // The order is the order the runners iterate in, and it is the order the
    // logs and the response body come out in. Test first because it is the
    // mode that actually has a catalog today.
    expect(STRIPE_MODES).toEqual(["test", "live"]);
  });

  it("reads a separate environment variable per mode", () => {
    // Two secrets, provisioned independently. Naming them in an exported map
    // rather than inline is what lets the failure message and the chart's
    // env block be checked against the same source.
    expect(stripeRead.KEY_ENV).toEqual({
      test: "STRIPE_RESTRICTED_READ_KEY_TEST",
      live: "STRIPE_RESTRICTED_READ_KEY_LIVE",
    });
  });

  it.each(STRIPE_MODES)("builds the %s client from that mode's key", async (mode) => {
    const key = uniqueKey(mode, "for_this_case_only");
    vi.stubEnv(stripeRead.KEY_ENV[mode], key);
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices(mode);

    expect(stripeMock.constructedWith).toEqual([expect.objectContaining({ key })]);
  });

  it("never reaches the other mode's key", async () => {
    // The whole point of the split. A live check that quietly read the test
    // key would report live as clean on the strength of test's catalog — a
    // false clean, in the one direction that revokes a write key.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", uniqueKey("test", "aaa"));
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", uniqueKey("live", "bbb"));
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices("live");

    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual([
      uniqueKey("live", "bbb"),
    ]);
  });
});

describe("listPrices", () => {
  it("asks for currency_options explicitly", async () => {
    // Stripe OMITS `currency_options` unless the request expands it. Without
    // this the six `developed` Prices read as covering one currency each, and
    // the comparator opens with 36 phantom `currency_missing_in_stripe`
    // findings — the single most likely way to poison the window by accident.
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices("test");

    expect(stripeMock.list).toHaveBeenCalledWith(
      expect.objectContaining({ expand: ["data.currency_options"] }),
    );
  });

  it("asks for active Prices only", async () => {
    // An archived Price is drift the catalog should see as
    // `price_missing_in_stripe`, not as a live Price that happens to match.
    stripeMock.list.mockReturnValue(pagesOf());
    await stripePriceReader.listPrices("test");
    expect(stripeMock.list).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
  });

  it("returns every page, not just the first", async () => {
    const pages = pagesOf({ id: "price_1" }, { id: "price_2" });
    stripeMock.list.mockReturnValue(pages);

    const prices = await stripePriceReader.listPrices("test");

    expect(prices.map((p) => p.id)).toEqual(["price_1", "price_2"]);
    expect(pages.autoPagingToArray).toHaveBeenCalledWith({ limit: stripeRead.MAX_PRICES });
  });
});

describe("the memo is per mode AND per key", () => {
  it("reuses a mode's client until that mode's key changes", async () => {
    // The memo exists so the environment is read at CALL time — the module
    // must be importable during the window before the chart supplies the
    // variables. Keying on the VALUE rather than caching once is what stops a
    // rotated key needing a pod restart to take effect.
    stripeMock.list.mockReturnValue(pagesOf());

    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", uniqueKey("test", "rotation_a"));
    await stripePriceReader.listPrices("test");
    await stripePriceReader.listPrices("test");
    expect(stripeMock.constructedWith).toHaveLength(1);

    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", uniqueKey("test", "rotation_b"));
    await stripePriceReader.listPrices("test");
    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual([
      uniqueKey("test", "rotation_a"),
      uniqueKey("test", "rotation_b"),
    ]);
  });

  it("does not rebuild the other mode's client when one key rotates", async () => {
    // A single-slot memo would evict live's client on every test run and vice
    // versa — two clients rebuilt per night forever, and, worse, a memo that
    // cannot be reasoned about when a key IS rotated.
    stripeMock.list.mockReturnValue(pagesOf());

    await stripePriceReader.listPrices("test");
    await stripePriceReader.listPrices("live");
    expect(stripeMock.constructedWith).toHaveLength(2);

    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", uniqueKey("test", "rotated"));
    await stripePriceReader.listPrices("test");
    await stripePriceReader.listPrices("live");

    // Three constructions, not four: live's client survived test's rotation.
    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual([
      "rk_test_readonly",
      "rk_live_readonly",
      uniqueKey("test", "rotated"),
    ]);
  });
});

describe("a missing credential", () => {
  it.each(STRIPE_MODES)(
    "fails the %s mode with a message naming that mode's variable",
    async (mode) => {
      // Stripe's own constructor throws "Neither apiKey nor
      // config.authenticator provided", which tells an operator reading a
      // `failed` parity run nothing about what to set. These two keys are
      // provisioned separately from every other secret in this estate AND from
      // each other, so "which one" is the whole question.
      vi.stubEnv(stripeRead.KEY_ENV[mode], "");

      await expect(stripePriceReader.listPrices(mode)).rejects.toThrowError(
        StripeReadUnavailableError,
      );
      await expect(stripePriceReader.listPrices(mode)).rejects.toThrowError(
        new RegExp(stripeRead.KEY_ENV[mode]),
      );
      expect(stripeMock.constructedWith).toEqual([]);
    },
  );

  it("leaves the other mode entirely usable", async () => {
    // BOTH KEYS ARE INDEPENDENTLY OPTIONAL. Live has no restricted key
    // provisioned yet and may not for some time; that must cost live's row
    // and nothing else. A module that threw on import, or a runner that
    // aborted on the first missing key, would take test's six months of
    // accumulated clean days down with it.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", "");
    stripeMock.list.mockReturnValue(pagesOf({ id: "price_1" }));

    await expect(stripePriceReader.listPrices("live")).rejects.toThrowError(
      StripeReadUnavailableError,
    );
    await expect(stripePriceReader.listPrices("test")).resolves.toHaveLength(1);
  });

  it("does not leak the key when one IS set", async () => {
    // Belt to the braces above: the error path must never grow into "expected
    // rk_live_..., got ...".
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", LIVE_KEY_FIXTURE);
    stripeMock.list.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(stripePriceReader.listPrices("live")).rejects.toThrowError(/boom/);
    await expect(stripePriceReader.listPrices("live")).rejects.not.toThrowError(
      /SECRETvalue/,
    );
  });
});

describe("a key whose prefix contradicts its slot", () => {
  // This exact mix-up cost an hour on 2026-08-27: a `rk_live_` key read as
  // though it were the test credential, reporting an empty account against a
  // 42-price catalog. Comparing against the WRONG ACCOUNT is the worst
  // available outcome — it is a wrong answer delivered confidently, which is
  // strictly worse than no answer at all, and no amount of reading the report
  // reveals it.

  it("fails the test slot when handed a live key", async () => {
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", LIVE_KEY_FIXTURE);

    await expect(stripePriceReader.listPrices("test")).rejects.toThrowError(
      StripeReadUnavailableError,
    );
    expect(stripeMock.constructedWith).toEqual([]);
  });

  it("fails the live slot when handed a test key", async () => {
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", TEST_KEY_FIXTURE);

    await expect(stripePriceReader.listPrices("live")).rejects.toThrowError(
      StripeReadUnavailableError,
    );
    expect(stripeMock.constructedWith).toEqual([]);
  });

  it("names both the variable and the mismatch, without quoting the key", async () => {
    // The message lands in the `error` column and in the CronJob's log. It has
    // to be enough to fix the misconfiguration — which variable, and what is
    // wrong with it — and it must not be a place a credential goes to live for
    // as long as the row does.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", LIVE_KEY_FIXTURE);

    const failure = await stripePriceReader
      .listPrices("test")
      .catch((cause: Error) => cause);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("STRIPE_RESTRICTED_READ_KEY_TEST");
    expect(message).toContain("live");
    expect(message).not.toContain("SECRETvalue");
  });

  it("accepts a key whose prefix agrees with its slot", async () => {
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_LIVE", LIVE_KEY_FIXTURE);
    stripeMock.list.mockReturnValue(pagesOf());

    await expect(stripePriceReader.listPrices("live")).resolves.toEqual([]);
  });

  it.each(["sk_live_abc", "pk_live_abc", "rk_live_abc"])(
    "recognises %s as a live key whatever its class",
    async (key) => {
      // Restricted, secret and publishable keys all carry the mode in the same
      // position. The guard keys off the mode, not the class.
      vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", key);
      await expect(stripePriceReader.listPrices("test")).rejects.toThrowError(
        StripeReadUnavailableError,
      );
    },
  );

  it("passes a key it cannot classify through rather than guessing", async () => {
    // Only a prefix that CONTRADICTS the slot is a failure. An unrecognised
    // shape is not evidence of anything — Stripe has introduced prefixes
    // before and this module must not be the reason a new one is unusable.
    // Stripe's own 401 is the right authority on a key it does not accept.
    vi.stubEnv("STRIPE_RESTRICTED_READ_KEY_TEST", "some_future_prefix_abc123");
    stripeMock.list.mockReturnValue(pagesOf());

    await expect(stripePriceReader.listPrices("test")).resolves.toEqual([]);
  });
});
