import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  verifyMachineAuthHeader: vi.fn(),
  getZitadelMachineConfig: vi.fn(() => ({
    issuer: "https://auth.tesserix.app",
    audience: "urn:tesserix:catalog-read",
    internalOrgId: undefined,
  })),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/promo-codes-repo", () => ({
  listPromoCodes: vi.fn(),
  readStripeCouponIdsForMode: vi.fn(),
}));

import { MachineTokenError, verifyMachineAuthHeader } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  listPromoCodes,
  readStripeCouponIdsForMode,
  type PromoCodeRow,
} from "@/lib/db/promo-codes-repo";
import { GET } from "./route";

/**
 * The product-facing promo read: `GET /api/v1/promo-catalog?mode=<test|live>`.
 *
 * The properties this suite exists to prove above everything else:
 *
 * 1. 401 (not authenticated) and 403 (authenticated but not permitted) are
 *    NEVER the same response, and the capability required is
 *    `read-promo-catalog` — holding `read-plan-catalog` is not enough.
 * 2. An EMPTY catalog is 200 with `codes: []`, deliberately unlike
 *    plan-catalog's 404. mark8ly caches this and treats an unrecognised code
 *    as invalid; "there are no codes" is the safe degradation, not a
 *    dangerous one.
 * 3. Expired and not-yet-started definitions ARE served, with their window,
 *    because a cached snapshot of "valid right now" would honour codes that
 *    have since expired. Deactivated ones are not served at all.
 * 4. `mode` selects an ACCOUNT, not a set of definitions, and a definition
 *    with no coupon minted in that mode is normal — the key is simply absent.
 */

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const URL_TEST = "https://console.tesserix.app/api/v1/promo-catalog?mode=test";
const URL_LIVE = "https://console.tesserix.app/api/v1/promo-catalog?mode=live";
const URL_NO_MODE = "https://console.tesserix.app/api/v1/promo-catalog";
const URL_BAD_MODE = "https://console.tesserix.app/api/v1/promo-catalog?mode=sandbox";

const AUTHED_HEADERS = { authorization: "Bearer machine-token" };

function identity(roles: readonly string[]) {
  return { sub: "service-user-1", clientId: "promo-reader", roles, orgId: undefined };
}

/** A trial-extension-only definition: no discount terms at all. */
const trialOnly: PromoCodeRow = {
  id: "11111111-1111-1111-1111-111111111111",
  source: "mark8ly",
  code: "EXTRA30",
  trialExtensionDays: 30,
  discount: null,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
  maxRedemptions: null,
  isActive: true,
  createdBy: "operator@tesserix.app",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/** A percent-off, repeating discount that also extends the trial. */
const percentOff: PromoCodeRow = {
  id: "22222222-2222-2222-2222-222222222222",
  source: "mark8ly",
  code: "LAUNCH50",
  trialExtensionDays: 14,
  discount: { kind: "percent_off", percentOff: 50, duration: "repeating", durationInMonths: 3 },
  validFrom: "2026-02-01T00:00:00.000Z",
  validUntil: "2026-12-31T00:00:00.000Z",
  maxRedemptions: 100,
  isActive: true,
  createdBy: "operator@tesserix.app",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

/** An amount-off, once-only discount. */
const amountOff: PromoCodeRow = {
  id: "33333333-3333-3333-3333-333333333333",
  source: "mark8ly",
  code: "FIVER",
  trialExtensionDays: null,
  discount: {
    kind: "amount_off",
    amountOffMinor: 500,
    currency: "usd",
    duration: "once",
    durationInMonths: null,
  },
  validFrom: "2026-03-01T00:00:00.000Z",
  validUntil: null,
  maxRedemptions: null,
  isActive: true,
  createdBy: "operator@tesserix.app",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity(["read-promo-catalog"]));
  vi.mocked(listPromoCodes).mockResolvedValue([trialOnly, percentOff, amountOff]);
  vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(
    new Map([[percentOff.id, "co_test_launch50"]]),
  );
});

describe("authentication: 401", () => {
  it("refuses a request with no bearer token, and the body carries no catalog data", async () => {
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("missing-token", "zitadel: missing or malformed Authorization header"),
    );

    const res = await GET(request(URL_TEST));

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("codes");
    expect(body).not.toHaveProperty("revision_id");
    expect(listPromoCodes).not.toHaveBeenCalled();
    expect(readStripeCouponIdsForMode).not.toHaveBeenCalled();
  });

  it("refuses an invalid or expired token the same way as a missing one", async () => {
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("invalid-token", "zitadel: machine token failed verification"),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(401);
    expect(listPromoCodes).not.toHaveBeenCalled();
  });

  it("answers 401, not 400, when the request is BOTH unauthenticated and carries an invalid mode", async () => {
    // Auth is checked before mode validation. If that order ever inverts, an
    // unauthenticated caller would learn something about the accepted `mode`
    // values before proving who it is — this pins the order, not just the
    // individual outcomes.
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("missing-token", "zitadel: missing or malformed Authorization header"),
    );

    const res = await GET(request(URL_BAD_MODE));

    expect(res.status).toBe(401);
    expect(res.status).not.toBe(400);
  });

  it("never surfaces the underlying jose failure carried on MachineTokenError.cause", async () => {
    const cause = Object.assign(new Error("JWT claim validation failed"), {
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
      payload: { sub: "service-user-1", aud: "wrong-audience" },
    });
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("invalid-token", "zitadel: machine token failed verification", cause),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const raw = JSON.stringify(await res.json());

    expect(res.status).toBe(401);
    expect(raw).not.toContain("wrong-audience");
    expect(raw).not.toContain("service-user-1");
    expect(raw).not.toContain("ERR_JWT_CLAIM_VALIDATION_FAILED");
  });
});

describe("authorization: 403, distinct from 401", () => {
  it("refuses a verified identity that lacks read-promo-catalog", async () => {
    vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity(["publish-catalog"]));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    // The property this suite is built to catch a regression of: a valid,
    // verified caller without the capability is 403, never 401.
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(listPromoCodes).not.toHaveBeenCalled();
  });

  it("does not accept read-plan-catalog in its place", async () => {
    // The two published contracts are separate grants. If the price reader's
    // existing token started working here, a grant already made would have
    // silently widened to every promo code in the estate.
    vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity(["read-plan-catalog"]));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(403);
  });

  it("refuses a verified identity with no roles at all", async () => {
    vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity([]));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(403);
  });
});

describe("mode validation: 400", () => {
  it("names the accepted values when mode is absent", async () => {
    const res = await GET(request(URL_NO_MODE, AUTHED_HEADERS));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("test");
    expect(body.message).toContain("live");
    expect(listPromoCodes).not.toHaveBeenCalled();
  });

  it("never defaults an unknown mode to a real one", async () => {
    const res = await GET(request(URL_BAD_MODE, AUTHED_HEADERS));

    expect(res.status).toBe(400);
    expect(listPromoCodes).not.toHaveBeenCalled();
    expect(readStripeCouponIdsForMode).not.toHaveBeenCalled();
  });
});

describe("the response shape", () => {
  it("returns the full contract, snake_cased, sorted by code", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      source: "mark8ly",
      mode: "test",
      revision_id: expect.any(String),
      codes: [
        {
          code: "EXTRA30",
          trial_extension_days: 30,
          discount: null,
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_until: null,
          max_redemptions: null,
        },
        {
          code: "FIVER",
          trial_extension_days: null,
          discount: {
            kind: "amount_off",
            amount_off_minor: 500,
            currency: "usd",
            duration: "once",
            duration_in_months: null,
          },
          valid_from: "2026-03-01T00:00:00.000Z",
          valid_until: null,
          max_redemptions: null,
        },
        {
          code: "LAUNCH50",
          trial_extension_days: 14,
          discount: {
            kind: "percent_off",
            percent_off: 50,
            duration: "repeating",
            duration_in_months: 3,
            stripe_coupon_id: "co_test_launch50",
          },
          valid_from: "2026-02-01T00:00:00.000Z",
          valid_until: "2026-12-31T00:00:00.000Z",
          max_redemptions: 100,
        },
      ],
    });
  });

  it("excludes the operator identity, the internal id, and the authoring timestamps", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const raw = JSON.stringify(await res.json());

    // `created_by` names an operator and must not cross into a product's
    // runtime, exactly as plan-catalog excludes `published_by`.
    expect(raw).not.toContain("created_by");
    expect(raw).not.toContain("operator@tesserix.app");
    // The uuid would be a second cross-repo key with no job — `code` is what
    // mark8ly's ledger references.
    expect(raw).not.toContain(percentOff.id);
    expect(raw).not.toContain("created_at");
    expect(raw).not.toContain("updated_at");
    // `is_active` is a filter, not a field: every row served is active.
    expect(raw).not.toContain("is_active");
  });

  it("carries max_redemptions but never a redemption count", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as { codes: Array<Record<string, unknown>> };
    const launch = body.codes.find((c) => c.code === "LAUNCH50");

    // mark8ly needs the cap to enforce it transactionally as the sole redeemer.
    expect(launch?.max_redemptions).toBe(100);
    // It must NOT get a count from here: the console does not write redemption
    // state, so any count it served would be trusted and wrong.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("redemption_count");
    expect(raw).not.toContain("redeemed");
    expect(raw).not.toContain("remaining");
  });

  it("reads with the required, non-defaulted source", async () => {
    await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(listPromoCodes).toHaveBeenCalledWith({ source: "mark8ly" });
  });

  it("does not ask for deactivated definitions", async () => {
    await GET(request(URL_TEST, AUTHED_HEADERS));

    // `includeInactive` left at its default. A deactivated code must not be
    // served at all, so a redeemer cannot honour one by forgetting a flag.
    const [options] = vi.mocked(listPromoCodes).mock.calls[0] as [
      { includeInactive?: boolean },
    ];
    expect(options.includeInactive).toBeUndefined();
  });
});

describe("an empty catalog: 200 with codes: [], deliberately not 404", () => {
  it("answers 200 with an empty array rather than 404", async () => {
    vi.mocked(listPromoCodes).mockResolvedValue([]);

    const res = await GET(request(URL_LIVE, AUTHED_HEADERS));

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    const body = (await res.json()) as { codes: unknown[] };
    // "No codes exist" is the safe degradation: every typed code is invalid
    // and the merchant onboards at the standard price. Unlike an empty plan
    // catalog, it cannot silently break anything.
    expect(body.codes).toEqual([]);
  });

  it("still carries a revision id and an ETag for the empty answer", async () => {
    vi.mocked(listPromoCodes).mockResolvedValue([]);

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as { revision_id: string };

    expect(body.revision_id).toBeTruthy();
    expect(res.headers.get("etag")).toBe(`"${body.revision_id}"`);
  });

  it("asks for coupons with an empty id list rather than skipping the call", async () => {
    // The short-circuit lives in the repository, where it can decline the
    // round trip; the route stays a single unconditional path so there is no
    // empty-catalog branch that only runs before the first definition exists.
    vi.mocked(listPromoCodes).mockResolvedValue([]);

    await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(readStripeCouponIdsForMode).toHaveBeenCalledWith("test", []);
  });
});

describe("the validity window is served, never filtered", () => {
  it("serves an expired definition with its window rather than dropping it", async () => {
    const expired: PromoCodeRow = {
      ...percentOff,
      code: "GONE",
      validUntil: "2020-01-01T00:00:00.000Z",
    };
    vi.mocked(listPromoCodes).mockResolvedValue([expired]);

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as { codes: Array<Record<string, unknown>> };

    // Filtering by the clock would make a cached snapshot honour codes that
    // have since expired, and would cost the merchant-facing distinction
    // between "that code expired" and "no such code".
    expect(body.codes).toHaveLength(1);
    expect(body.codes[0].code).toBe("GONE");
    expect(body.codes[0].valid_until).toBe("2020-01-01T00:00:00.000Z");
  });

  it("serves a not-yet-started definition with its window", async () => {
    const future: PromoCodeRow = {
      ...trialOnly,
      code: "SOON",
      validFrom: "2099-01-01T00:00:00.000Z",
    };
    vi.mocked(listPromoCodes).mockResolvedValue([future]);

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as { codes: Array<Record<string, unknown>> };

    expect(body.codes).toHaveLength(1);
    expect(body.codes[0].valid_from).toBe("2099-01-01T00:00:00.000Z");
  });
});

describe("mode selects an account, not a set of definitions", () => {
  it("reads coupons for the mode the caller asked for", async () => {
    await GET(request(URL_LIVE, AUTHED_HEADERS));

    expect(readStripeCouponIdsForMode).toHaveBeenCalledWith("live", [
      trialOnly.id,
      percentOff.id,
      amountOff.id,
    ]);
  });

  it("serves the same definitions in both modes, differing only in the coupon id", async () => {
    const testRes = await GET(request(URL_TEST, AUTHED_HEADERS));
    const testBody = (await testRes.json()) as { codes: Array<{ code: string }> };

    vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(
      new Map([[percentOff.id, "co_live_launch50"]]),
    );
    const liveRes = await GET(request(URL_LIVE, AUTHED_HEADERS));
    const liveBody = (await liveRes.json()) as {
      codes: Array<{ code: string; discount: { stripe_coupon_id?: string } | null }>;
    };

    expect(liveBody.codes.map((c) => c.code)).toEqual(testBody.codes.map((c) => c.code));
    expect(liveBody.codes.find((c) => c.code === "LAUNCH50")?.discount?.stripe_coupon_id).toBe(
      "co_live_launch50",
    );
  });

  it("OMITS stripe_coupon_id for a definition with no coupon minted in this mode", async () => {
    // The normal state, not a defect: nothing in this estate has bootstrapped
    // live, so every definition's live coupon is absent today.
    vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(new Map());

    const res = await GET(request(URL_LIVE, AUTHED_HEADERS));
    const body = (await res.json()) as {
      codes: Array<{ code: string; discount: Record<string, unknown> | null }>;
    };
    const launch = body.codes.find((c) => c.code === "LAUNCH50");

    expect(launch?.discount).not.toBeNull();
    // Absent, not null: a null reads as a value that failed to arrive.
    expect(launch?.discount).not.toHaveProperty("stripe_coupon_id");
    expect(JSON.stringify(body)).not.toContain("stripe_coupon_id");
    // The rest of the terms are still there — the trial extension on this code
    // still applies in a mode with no coupon.
    expect(launch?.discount?.percent_off).toBe(50);
  });

  it("attaches each coupon to its own definition, never to another", async () => {
    vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(
      new Map([
        [percentOff.id, "co_for_launch50"],
        [amountOff.id, "co_for_fiver"],
      ]),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as {
      codes: Array<{ code: string; discount: { stripe_coupon_id?: string } | null }>;
    };

    expect(body.codes.find((c) => c.code === "LAUNCH50")?.discount?.stripe_coupon_id).toBe(
      "co_for_launch50",
    );
    expect(body.codes.find((c) => c.code === "FIVER")?.discount?.stripe_coupon_id).toBe(
      "co_for_fiver",
    );
    // A trial-extension-only code has no discount to hang a coupon on.
    expect(body.codes.find((c) => c.code === "EXTRA30")?.discount).toBeNull();
  });
});

describe("caching: explicit Cache-Control and a content-derived ETag", () => {
  it("carries an explicit no-cache Cache-Control on the 200", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("carries an ETag equal to the revision id in the body", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    const body = (await res.json()) as { revision_id: string };

    expect(res.headers.get("etag")).toBe(`"${body.revision_id}"`);
  });

  it("is stable across identical reads, so an unchanged catalog revalidates cheaply", async () => {
    const first = await GET(request(URL_TEST, AUTHED_HEADERS));
    const second = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
  });

  it("changes when a definition changes", async () => {
    const before = (await GET(request(URL_TEST, AUTHED_HEADERS))).headers.get("etag");

    vi.mocked(listPromoCodes).mockResolvedValue([
      trialOnly,
      { ...percentOff, maxRedemptions: 101 },
      amountOff,
    ]);
    const after = (await GET(request(URL_TEST, AUTHED_HEADERS))).headers.get("etag");

    expect(after).not.toBe(before);
  });

  it("changes when only the minted coupon changes", async () => {
    const before = (await GET(request(URL_TEST, AUTHED_HEADERS))).headers.get("etag");

    vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(
      new Map([[percentOff.id, "co_something_else"]]),
    );
    const after = (await GET(request(URL_TEST, AUTHED_HEADERS))).headers.get("etag");

    expect(after).not.toBe(before);
  });

  it("differs between modes even when nothing is minted in either", async () => {
    // Without `mode` inside the hash these two bodies would share an ETag, and
    // a caller switching modes with an If-None-Match would be told 304 for a
    // body it has never seen.
    vi.mocked(readStripeCouponIdsForMode).mockResolvedValue(new Map());

    const testEtag = (await GET(request(URL_TEST, AUTHED_HEADERS))).headers.get("etag");
    const liveEtag = (await GET(request(URL_LIVE, AUTHED_HEADERS))).headers.get("etag");

    expect(testEtag).not.toBe(liveEtag);
  });

  it("does not vary the body with the wall clock", async () => {
    // No `generated_at`: a per-request timestamp would make two responses with
    // the same ETag differ, which is exactly what an entity tag promises does
    // not happen.
    const first = await (await GET(request(URL_TEST, AUTHED_HEADERS))).text();
    const second = await (await GET(request(URL_TEST, AUTHED_HEADERS))).text();

    expect(first).toBe(second);
  });
});

describe("conditional requests: 304 with no body", () => {
  async function currentEtag(): Promise<string> {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));
    return res.headers.get("etag") as string;
  }

  it("answers 304 with no body when If-None-Match matches the current revision", async () => {
    const etag = await currentEtag();

    const res = await GET(request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": etag }));

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("accepts the weak-comparison W/ form of the same tag", async () => {
    const etag = await currentEtag();

    const res = await GET(request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": `W/${etag}` }));

    expect(res.status).toBe(304);
  });

  it("still carries Cache-Control and ETag on a 304", async () => {
    const etag = await currentEtag();

    const res = await GET(request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": etag }));

    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 200 in full when If-None-Match names a stale revision", async () => {
    const res = await GET(
      request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": '"not-the-current-revision"' }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { codes: unknown[] };
    expect(body.codes).toHaveLength(3);
  });
});

describe("a database failure: 5xx, never a partial catalog", () => {
  it("answers 5xx when listing the definitions fails", async () => {
    vi.mocked(listPromoCodes).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("codes");
  });

  it("answers 5xx when reading the coupons fails, after the definitions succeeded", async () => {
    vi.mocked(readStripeCouponIdsForMode).mockRejectedValue(
      new Error("relation does not exist"),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as Record<string, unknown>;
    // No half-built catalog: definitions read before the failure must not
    // reach the response without their coupons.
    expect(body).not.toHaveProperty("codes");
    expect(body).not.toHaveProperty("revision_id");
    expect(JSON.stringify(body)).not.toContain("LAUNCH50");
  });

  it("never leaks the driver's error message", async () => {
    vi.mocked(listPromoCodes).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});

describe("the data plane not being wired up yet", () => {
  it("answers 501 rather than attempting a read it cannot serve", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(501);
    expect(listPromoCodes).not.toHaveBeenCalled();
  });
});
