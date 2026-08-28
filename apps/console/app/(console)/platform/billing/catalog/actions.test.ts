import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/publish-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/publish-repo")>()),
  createDraftFrom: vi.fn(),
  discardDraft: vi.fn(),
  setDraftAmount: vi.fn(),
  startPublishAttempt: vi.fn(),
  promotePublication: vi.fn(),
}));
// The publish half's three leaf dependencies. `buildPublishPlan`,
// `checkGuards` and `scopeObserved` are deliberately NOT mocked — the plan
// this action builds, and the verdict it acts on, are the real ones (the
// same discipline Ruling 15 applies to `auditedOperation` above). Only the
// database reads, the Stripe read and the Stripe WRITE are stood in for.
vi.mock("@/lib/db/plan-catalog-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/plan-catalog-repo")>()),
  readCatalogAmounts: vi.fn(),
  readRevisionAmounts: vi.fn(),
}));
vi.mock("@/lib/billing/stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe-read")>()),
  stripePriceReader: { listPrices: vi.fn() },
}));
vi.mock("@/lib/billing/publish-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/publish-executor")>()),
  executePublish: vi.fn(),
}));
// `findOrphans` itself does two more reads (`archivedStripePriceIds`,
// `stripePriceReader.listPrices`) that have no place in a `publishAction`
// unit test — stood in for directly, same as `executePublish` above.
vi.mock("@/lib/billing/orphans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/orphans")>()),
  findOrphans: vi.fn(),
}));
// Same discipline `crm/[organisation]/actions.test.ts` applies (Ruling 15):
// `auditedOperation` itself is NOT mocked — only its two leaf dependencies
// are, so a passing test here is evidence about the real audit control this
// action wraps, not about a hand-rolled stand-in for it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import {
  createDraftFrom,
  discardDraft,
  promotePublication,
  setDraftAmount,
  startPublishAttempt,
} from "@/lib/db/publish-repo";
import { readCatalogAmounts, readRevisionAmounts } from "@/lib/db/plan-catalog-repo";
import { stripePriceReader } from "@/lib/billing/stripe-read";
import { executePublish } from "@/lib/billing/publish-executor";
import { findOrphans } from "@/lib/billing/orphans";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  discardDraftAction,
  planPublishAction,
  publishAction,
  setAmountAction,
  startDraftAction,
} from "./actions";

/**
 * Coordinator review item 4: `setAmountAction` (and its siblings) had zero
 * coverage — the render suite mocks `./actions` wholesale, and none of its
 * tests blur an input, so the server-side validation, the capability gate,
 * the audit description, and the failure-message mapping were all
 * unexercised. This file covers `withDraftWrite`'s three callers directly,
 * against the REAL `auditedOperation`/`checkOperatorCapability` — the same
 * pattern `crm/[organisation]/actions.test.ts` establishes.
 */

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "operator-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The one write `writeAuditEntry` issues — `[actor, action, target,
 *  occurredAt, metadata]`, per `audit-repo.ts`. */
function lastAuditInsert(): { action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { action, target, summary: metadata ? JSON.parse(metadata) : null };
}

const NO_PERMISSION = "You don't have permission to edit the plan catalog.";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startDraftAction", () => {
  it("starts a draft, audits billing.catalog.draft.start, and revalidates the catalog surface", async () => {
    signIn(["billing"]);
    vi.mocked(createDraftFrom).mockResolvedValue("draft-1");

    const result = await startDraftAction("test");

    expect(result).toEqual({ ok: true });
    expect(createDraftFrom).toHaveBeenCalledWith("test", "operator-1");
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.draft.start",
      target: "test (draft-1)",
      summary: { started: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("refuses without billing, before any repo or audit call", async () => {
    signIn(undefined);

    const result = await startDraftAction("test");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(createDraftFrom).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setAmountAction", () => {
  it("rejects a negative amount before any session or database work", async () => {
    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", -1);

    expect(result).toEqual({ ok: false, message: "Enter a whole number of minor units." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(setDraftAmount).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  // `plan_catalog_amounts.unit_amount_minor` is CHECK'd `> 0` (0032) — a zero
  // can only mean "not set", so it is refused the same way a negative
  // amount is, not treated as a valid boundary value.
  it("rejects zero — '> 0', not '>= 0'", async () => {
    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", 0);

    expect(result).toEqual({ ok: false, message: "Enter a whole number of minor units." });
    expect(setDraftAmount).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount before any session or database work", async () => {
    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", 119.5);

    expect(result).toEqual({ ok: false, message: "Enter a whole number of minor units." });
    expect(setDraftAmount).not.toHaveBeenCalled();
  });

  it("sets the amount, audits billing.catalog.draft.amount.set, and revalidates", async () => {
    signIn(["billing"]);
    vi.mocked(setDraftAmount).mockResolvedValue(undefined);

    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", 11_900);

    expect(result).toEqual({ ok: true });
    expect(setDraftAmount).toHaveBeenCalledWith({
      revisionId: "draft-1",
      source: "mark8ly",
      lookupKey: "mark8ly_pro_monthly_developed_v1",
      currency: "usd",
      unitAmountMinor: 11_900,
    });
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.draft.amount.set",
      target: "mark8ly_pro_monthly_developed_v1 (usd)",
      summary: { updated: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("refuses without billing, before the repo is touched", async () => {
    signIn(undefined);

    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", 11_900);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(setDraftAmount).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("maps a repo refusal (e.g. a stale/published revisionId) to the generic not-saved message", async () => {
    // `setDraftAmount` itself refuses a lookup_key/revision it doesn't own —
    // see `publish-repo.ts`. This action does not have (or need) an
    // allowlisted exception for that refusal yet — see this file's own
    // comment on `NOT_SAVED_MESSAGE` — so it degrades to the conservative
    // default rather than leaking the repo's internal wording.
    signIn(["billing"]);
    vi.mocked(setDraftAmount).mockRejectedValue(
      new Error('setDraftAmount: "x" is not a price in draft revision draft-1'),
    );

    const result = await setAmountAction("draft-1", "x", "usd", 100);

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("discardDraftAction", () => {
  it("discards the draft, audits billing.catalog.draft.discard, and revalidates", async () => {
    signIn(["billing"]);
    vi.mocked(discardDraft).mockResolvedValue(undefined);

    const result = await discardDraftAction("draft-1");

    expect(result).toEqual({ ok: true });
    expect(discardDraft).toHaveBeenCalledWith("draft-1");
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.draft.discard",
      target: "draft-1",
      summary: { discarded: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("refuses without billing, before the repo is touched", async () => {
    signIn(undefined);

    const result = await discardDraftAction("draft-1");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(discardDraft).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("maps a repo refusal an operator CAN act on to a sentence written for them", async () => {
    // The allowlist this task added (`ACTIONABLE_REFUSALS`) — T3 left it
    // empty because nothing surfaced could reach these refusals; the publish
    // screen can. The repo's own wording (with its revision uuid and mode)
    // is replaced, never passed through.
    signIn(["billing"]);
    vi.mocked(discardDraft).mockRejectedValue(
      new Error("discardDraft: revision draft-1 is published to test and cannot be discarded"),
    );

    const result = await discardDraftAction("draft-1");

    expect(result).toEqual({
      ok: false,
      message: "That revision is published. A published revision cannot be edited or discarded.",
    });
  });
});

/**
 * The publish half. `buildPublishPlan`, `checkGuards` and `scopeObserved`
 * run for real here (see the mock block at the top of this file) — only the
 * two catalog reads, the Stripe read, the Stripe write (`executePublish`)
 * and the two publish-log writes are stood in for.
 */
describe("publishAction", () => {
  const NO_PUBLISH_PERMISSION = "You don't have permission to publish the plan catalog.";
  const CONFIRMED = { typedMode: "test", acknowledged: [] as const };

  function observeNothing() {
    // An empty ancestor, an empty draft and an empty Stripe: a plan with no
    // operations, which `checkGuards` passes in `test` and refuses in `live`
    // on the MODE rule alone. Exactly the isolation these tests want — the
    // plan's own construction is `publish-plan.test.ts`'s subject.
    vi.mocked(readCatalogAmounts).mockResolvedValue([]);
    vi.mocked(readRevisionAmounts).mockResolvedValue([]);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
  }

  beforeEach(() => {
    observeNothing();
    vi.mocked(startPublishAttempt).mockResolvedValue("attempt-1");
    vi.mocked(promotePublication).mockResolvedValue("publication-1");
    vi.mocked(findOrphans).mockResolvedValue([]);
  });

  it("refuses a mistyped mode before any session, Stripe or database work", async () => {
    const result = await publishAction("draft-1", "test", { typedMode: "tset", acknowledged: [] });

    expect(result).toEqual({ ok: false, message: 'Type "test" to confirm before publishing.' });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(startPublishAttempt).not.toHaveBeenCalled();
  });

  it("refuses an operator holding billing but not publish-catalog", async () => {
    // The whole point of the risk verb: `billing` is the surface, and every
    // operator who can READ this catalog holds it.
    signIn(["billing"]);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({ ok: false, message: NO_PUBLISH_PERMISSION });
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("publishes, then PROMOTES the revision, and audits both facts", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(executePublish).mockResolvedValue({ outcome: "succeeded", operations: [] });

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: true,
      attemptId: "attempt-1",
      outcome: "succeeded",
      promoted: true,
      failedOperations: [],
      operations: [],
      orphans: [],
    });
    // Orphans are checked ONLY on a failed attempt — see `publishAction`'s
    // own doc comment and `orphans.ts`'s header on why a succeeded attempt
    // has nothing for `findOrphans` to find.
    expect(findOrphans).not.toHaveBeenCalled();
    expect(startPublishAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: "draft-1", mode: "test", startedBy: "operator-1" }),
    );
    expect(executePublish).toHaveBeenCalledWith("attempt-1");
    // The write `executePublish` deliberately does not make. Without it a
    // green publish leaves `plan_catalog_publications` naming the PREVIOUS
    // revision, and 0036's clean-run-names-publication constraint turns the
    // nightly parity check red — resetting #327's observation window.
    expect(promotePublication).toHaveBeenCalledWith("test", "draft-1", "operator-1");
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.publish",
      target: "test (draft-1)",
      summary: { failed: 0, promoted: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("does NOT promote a partial success — a wrong claim in the record is worse than an incomplete one", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(executePublish).mockResolvedValue({
      // `executePublish` has no "partial" outcome: any failed operation
      // closes the attempt "failed", even though the others already landed
      // in Stripe.
      outcome: "failed",
      operations: [
        { kind: "replace_price", lookupKey: "mark8ly_pro_monthly_developed_v1", status: "succeeded" },
        { kind: "archive_price", lookupKey: "mark8ly_pro_annual_ppp_v1", status: "failed", error: "card_declined" },
      ],
    });
    vi.mocked(findOrphans).mockResolvedValue([
      { priceId: "price_stale", lookupKey: null, source: "mark8ly" },
    ]);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: true,
      attemptId: "attempt-1",
      outcome: "failed",
      promoted: false,
      failedOperations: ["archive_price mark8ly_pro_annual_ppp_v1"],
      operations: [
        { sequence: 1, kind: "replace_price", lookupKey: "mark8ly_pro_monthly_developed_v1", status: "succeeded", error: null },
        { sequence: 2, kind: "archive_price", lookupKey: "mark8ly_pro_annual_ppp_v1", status: "failed", error: "card_declined" },
      ],
      orphans: [{ priceId: "price_stale", lookupKey: null, source: "mark8ly" }],
    });
    expect(findOrphans).toHaveBeenCalledWith("test");
    expect(promotePublication).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.publish",
      target: "test (draft-1)",
      summary: { failed: 1, promoted: 0 },
    });
  });

  it("refuses live before opening an attempt, and says the guard's own reason", async () => {
    signIn(["billing", "publish-catalog"]);

    const result = await publishAction("draft-1", "live", { typedMode: "live", acknowledged: [] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/refused in v1/);
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();
    expect(promotePublication).not.toHaveBeenCalled();
    // `checkMode` refuses "live" on its own, with no observed data — see
    // `observeAndPlan`'s short-circuit in `actions.ts`. Nothing justifies
    // spending a paid `prices.list` call to learn a refusal the mode string
    // alone already carries.
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("maps a second concurrent publish to a sentence the operator can act on", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(startPublishAttempt).mockRejectedValue(
      new Error(
        "startPublishAttempt: an open publish attempt already exists for test (attempt a1) — finish or abort it before starting another",
      ),
    );

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: false,
      message: "A publish is already in progress for this mode. Wait for it to finish before starting another.",
    });
    expect(executePublish).not.toHaveBeenCalled();
  });

  it("never leaks internal failure text, and never claims nothing happened", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(executePublish).mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:5432"));

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: false,
      message:
        "The publish could not be completed. Check the publish log before retrying — some operations may already have run.",
    });
    expect(promotePublication).not.toHaveBeenCalled();
  });
});

describe("planPublishAction", () => {
  beforeEach(() => {
    vi.mocked(readCatalogAmounts).mockResolvedValue([]);
    vi.mocked(readRevisionAmounts).mockResolvedValue([]);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
  });

  it("builds a real plan against Stripe for a mode that can actually publish", async () => {
    signIn(["billing"]);

    const result = await planPublishAction("draft-1", "test");

    expect(result.ok).toBe(true);
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("test");
  });

  // The bug this guards: `AuthoringPanel`'s `PublishSection` calls this
  // action from a `useEffect` on every render of an open draft, including
  // `mode=live` — and `checkGuards`' `mode` rule refuses "live"
  // unconditionally (see `publish-guards.ts`), so that call's Stripe read
  // could only ever confirm what the mode string alone already says. It
  // must not run.
  it("never reads Stripe for live — checkMode refuses it before any observation happens", async () => {
    signIn(["billing"]);

    const result = await planPublishAction("draft-1", "live");

    expect(result.ok).toBe(true);
    expect(result.ok && result.plan.verdict).toEqual({
      ok: false,
      refused: [
        {
          rule: "mode",
          message: 'Publishing to Stripe mode "live" is refused in v1 — only "test" is enabled.',
        },
      ],
    });
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(readCatalogAmounts).not.toHaveBeenCalled();
    expect(readRevisionAmounts).not.toHaveBeenCalled();
  });
});
