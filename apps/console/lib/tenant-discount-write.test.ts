import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The console's half of the tenant discount call (tesserix-home#331, T1).
 *
 * # The request is asserted against the CONTRACT, not against this module
 *
 * Every expectation below is spelled from platform-api's own shipped code —
 * `internal/modules/billing/internal/handler/handler.go` for the paths, the
 * mandatory `Idempotency-Key` and the two refusals, and `service/discount.go`
 * for the rule that the tenant id is passed WHOLE and split on the far side.
 * A test that re-derived the path or the key from the implementation would
 * pass just as happily against a request platform-api refuses.
 *
 * Mocked at `@/lib/platform-api`, the same seam `tools-write.test.ts` mocks:
 * the transport, the operator token and the envelope are that module's
 * business and are tested in `platform-api.test.ts`.
 */
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: vi.fn(() => "https://api.test"),
  platformRequestWithMeta: vi.fn(),
}));
/**
 * The audit driver, mocked so "this seam writes no console audit row" can be
 * asserted against what reaches Postgres rather than against an import list.
 * `tenant-pricing-override-write.test.ts` mocks the same module for the
 * opposite assertion — that its own `.mint` and `.retire` rows DO land.
 */
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: () => true,
  tesserixQuery: vi.fn(async () => []),
}));

import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { tesserixQuery } from "@/lib/db/tesserix";
import {
  applyTenantDiscount,
  removeTenantDiscount,
  type TenantDiscountInput,
} from "./tenant-discount-write";

afterEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformApiOrigin).mockReturnValue("https://api.test");
});

const TENANT = "mark8ly:2b0f5f9e-1f2a-4c31-9c66-6f3d2b8e5a10";

/** The id as it must appear in the path: percent-encoded, and otherwise
 *  WHOLE. Spelled as a literal rather than built with `encodeURIComponent`,
 *  so a change of encoding is a failing test rather than a silent agreement
 *  between the test and the code. */
const ENCODED_TENANT = "mark8ly%3A2b0f5f9e-1f2a-4c31-9c66-6f3d2b8e5a10";

const INPUT: TenantDiscountInput = {
  tenantId: TENANT,
  mode: "live",
  couponId: "co_live_abc",
  reason: "Churn risk escalated by the founder at renewal.",
};

/** One store, applied, and nothing to reconcile — mark8ly's happy report. */
function reported(body: Record<string, unknown>) {
  vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: body, meta: null });
}

/** The call's (path, init) as the seam sent them. */
function sent() {
  const [label, path, init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
  return { label, path, init };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("the request platform-api is given", () => {
  it("posts the namespaced tenant id WHOLE, to the apply path", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);

    const { path, init } = sent();
    // platform-api splits on the FIRST colon to decide which product owns the
    // tenant (`service/discount.go:54`) and refuses a bare id rather than
    // aiming it at a default. Sending the product's own id would be refused;
    // sending the namespace stripped would be worse.
    expect(path).toBe(`/v1/billing/tenants/${ENCODED_TENANT}/discount`);
    expect(init?.method).toBe("POST");
  });

  it("posts to the remove path for a detach, which is a POST and not a DELETE", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await removeTenantDiscount(INPUT);

    // POST .../discount/remove, because both verbs carry a body and the
    // federated request is signed over a hash of it — an intermediary is
    // permitted to drop a DELETE's body, which surfaces as a 401.
    const { path, init } = sent();
    expect(path).toBe(`/v1/billing/tenants/${ENCODED_TENANT}/discount/remove`);
    expect(init?.method).toBe("POST");
  });

  it("sends the coupon and the reason under the product's own field names", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);

    const { init } = sent();
    expect(headerOf(init, "content-type")).toBe("application/json");
    // `domain.DiscountRequest` — snake_case, both required and both refused
    // blank by the handler. The operator's reason travels because mark8ly
    // writes it into the audit row inside each store's transaction.
    expect(JSON.parse(String(init?.body))).toEqual({
      coupon_id: "co_live_abc",
      reason: "Churn risk escalated by the founder at renewal.",
    });
  });

  it("sends an Idempotency-Key, which the endpoint refuses to generate for us", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);

    // Spelled out rather than read back from the module: the exact string is
    // the contract with mark8ly's replay store, which scopes it
    // `tenant_discount:<op>:<tenant>:<key>`.
    expect(headerOf(sent().init, "idempotency-key")).toBe(
      `tenant-override-attach:v1:${TENANT}:live:co_live_abc`,
    );
  });

  it("sends the SAME key for the same grant twice, so a retry cannot double-apply", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);
    await applyTenantDiscount(INPUT);

    // DETERMINISTIC, unlike `tenant-lifecycle-write.ts`'s `randomUUID()`. A
    // fresh key on every attempt is the same as having none: the retry after a
    // lost response is exactly the case the key exists for.
    const keys = vi
      .mocked(platformRequestWithMeta)
      .mock.calls.map((call) => headerOf(call[2], "idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
  });

  it("keys apply and remove apart, so a remove cannot replay an apply's report", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);
    await removeTenantDiscount(INPUT);

    const [attach, detach] = vi
      .mocked(platformRequestWithMeta)
      .mock.calls.map((call) => headerOf(call[2], "idempotency-key"));
    expect(attach).toBe(`tenant-override-attach:v1:${TENANT}:live:co_live_abc`);
    expect(detach).toBe(`tenant-override-detach:v1:${TENANT}:live:co_live_abc`);
    expect(attach).not.toBe(detach);
  });

  it("keys on the coupon and the mode, so a second grant is not the first one's retry", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);
    await applyTenantDiscount({ ...INPUT, couponId: "co_live_second" });
    await applyTenantDiscount({ ...INPUT, mode: "test" });

    const keys = vi
      .mocked(platformRequestWithMeta)
      .mock.calls.map((call) => headerOf(call[2], "idempotency-key"));
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps the reason OUT of the key, so a reworded justification is not a fresh attempt", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);
    await applyTenantDiscount({ ...INPUT, reason: "Different wording entirely." });

    const keys = vi
      .mocked(platformRequestWithMeta)
      .mock.calls.map((call) => headerOf(call[2], "idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
  });

  it("writes no console audit row — the product owns the row for a federated write", async () => {
    reported({ status: "ok", requires_reconciliation: false, stores: [] });

    await applyTenantDiscount(INPUT);

    const audits = vi
      .mocked(tesserixQuery)
      .mock.calls.filter(([sql]) => sql.includes("INSERT INTO console_audit_log"));
    expect(audits).toEqual([]);
  });
});

describe("the report that comes back", () => {
  it("carries the status, the reconciliation flag and every store", async () => {
    reported({
      status: "partial",
      requires_reconciliation: true,
      stores: [
        { store_id: "s-1", outcome: "applied" },
        {
          store_id: "s-2",
          outcome: "failed",
          failure_code: "stripe_call_failed",
          failure_reason: "the stripe call failed and nothing was changed for this store; it can be retried",
        },
      ],
    });

    const result = await applyTenantDiscount(INPUT);

    expect(result).toEqual({
      ok: true,
      status: "partial",
      requiresReconciliation: true,
      stores: [
        { storeId: "s-1", outcome: "applied" },
        {
          storeId: "s-2",
          outcome: "failed",
          failureReason:
            "the stripe call failed and nothing was changed for this store; it can be retried",
        },
      ],
    });
  });

  it("narrows a status and an outcome this build has never heard of", async () => {
    reported({
      status: "mostly",
      requires_reconciliation: false,
      stores: [{ store_id: "s-1", outcome: "teleported" }],
    });

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Named rather than passed through: a value this build cannot place must
    // render as "we do not recognise what happened here" rather than as a
    // word an operator reads as an outcome.
    expect(result.status).toBe("unknown");
    expect(result.stores[0].outcome).toBe("unknown");
  });

  it("survives a report with no stores array at all", async () => {
    reported({ status: "ok", requires_reconciliation: false });

    const result = await applyTenantDiscount(INPUT);

    expect(result).toEqual({
      ok: true,
      status: "ok",
      requiresReconciliation: false,
      stores: [],
    });
  });

  it("treats a missing reconciliation flag as unset rather than as truthy", async () => {
    reported({ status: "ok", stores: [] });

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok && result.requiresReconciliation).toBe(false);
  });
});

describe("when the call does not succeed", () => {
  it("surfaces the product's own sentence from a 400", async () => {
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError(
        "tenant discount: BAD_REQUEST — the product refused this change: coupon_not_found",
        400,
      ),
    );

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The refusal names a product code, which is the only actionable thing a
    // refusal carries. Collapsing it to "the request failed" leaves an
    // operator with no idea what mark8ly objected to.
    expect(result.message).toContain("coupon_not_found");
  });

  it("reports a 403 as a permission refusal, not as a fault", async () => {
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tenant discount: FORBIDDEN — capability required", 403),
    );

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/permission/i);
  });

  it("never claims nothing happened when the product could not be reached", async () => {
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError(
        "tenant discount: SERVICE_UNAVAILABLE — the product could not be reached to apply this discount",
        503,
      ),
    );

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // A transport failure after mark8ly committed is indistinguishable from
    // one before it. "Nothing was applied" asserts the second, and an operator
    // who believes it grants the discount a second time.
    expect(result.message.toLowerCase()).not.toMatch(/nothing (was|happened)/);
    expect(result.message).toMatch(/mark8ly|the product/i);
  });

  it("says an unconfigured origin is a deployment setting, and sends nothing", async () => {
    vi.mocked(platformApiOrigin).mockReturnValue(null);

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // A pure misconfiguration, and the one failure here that IS unambiguous:
    // no request was made. Reporting it as "could not be reached" would send
    // an operator hunting a discount that was never asked for.
    expect(result.message).toContain("PLATFORM_API_ORIGIN");
    // It is also the only message here allowed to say nothing was sent, and it
    // must: the ambiguity every other failure carries is genuinely absent.
    expect(result.message).toMatch(/nothing was sent/i);
    expect(platformRequestWithMeta).not.toHaveBeenCalled();
  });

  it("does not claim nothing happened when the failure carries no status at all", async () => {
    // `platformCall` throws statusless for a lost fetch and for a session with
    // no operator token, as well as for the unset origin the branch above
    // catches first. None of them can say whether mark8ly acted.
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tenant discount: request failed (fetch failed)"),
    );

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message.toLowerCase()).not.toMatch(/nothing (was|happened)/);
  });

  it("does not leak a thrown internal into the operator's sentence", async () => {
    vi.mocked(platformRequestWithMeta).mockRejectedValue(new TypeError("headers is not iterable"));

    const result = await applyTenantDiscount(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toContain("headers is not iterable");
  });
});
