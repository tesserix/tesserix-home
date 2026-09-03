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
import { MARK8LY_LOOKUP_KEY_PREFIX, type CatalogAmount, type StripePriceLike } from "@/lib/billing/parity";
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

/** Fixture builders matching `publish-plan.test.ts`'s own — a
 *  `mark8ly_`-prefixed lookup key, because `compareCatalogToStripe` filters
 *  the OBSERVED side by that prefix. */
function amount(lookupKey: string, currency: string, unitAmountMinor: number): CatalogAmount {
  return { lookupKey, currency, unitAmountMinor, taxBehavior: "unspecified" };
}

function price(overrides: {
  lookup_key: string;
  currency: string;
  unit_amount: number;
  currency_options?: StripePriceLike["currency_options"];
}): StripePriceLike {
  return {
    id: `price_${overrides.lookup_key}`,
    lookup_key: overrides.lookup_key,
    currency: overrides.currency,
    unit_amount: overrides.unit_amount,
    tax_behavior: "unspecified",
    active: true,
    currency_options: overrides.currency_options,
  };
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

  it("refuses without billing, before the repo is touched, and audits the refusal", async () => {
    // #409 task 3: the capability check now runs INSIDE `auditedOperation`
    // (`withDraftWrite`), so a refusal writes a `capability.refused` row
    // instead of writing nothing — before this task, `checkOperatorCapability`
    // ran before `auditedOperation` and this refusal was silent. The repo is
    // still never touched: the audit write is `auditedOperation`'s own, not
    // `createDraftFrom`'s.
    signIn(undefined);

    const result = await startDraftAction("test");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(createDraftFrom).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "test",
      summary: { billing: 1 },
    });
  });

  // Pins the ordering decision (#409 task 3): `auditedOperation` refuses
  // BEFORE running `operation` at all when the database is not configured,
  // so the capability check inside it never runs either — the caller sees
  // "not saved", not "no permission", even though the capability would also
  // have been refused. Breaks if the capability check moves back outside
  // `operation`.
  it("fails closed on AuditUnavailableError before the capability check, when no database is configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(undefined);

    const result = await startDraftAction("test");

    expect(createDraftFrom).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "That change was not saved." });
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

  it("refuses without billing, before the repo is touched, and audits the refusal", async () => {
    signIn(undefined);

    const result = await setAmountAction("draft-1", "mark8ly_pro_monthly_developed_v1", "usd", 11_900);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(setDraftAmount).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "mark8ly_pro_monthly_developed_v1 (usd)",
      summary: { billing: 1 },
    });
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

  it("refuses without billing, before the repo is touched, and audits the refusal", async () => {
    signIn(undefined);

    const result = await discardDraftAction("draft-1");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(discardDraft).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "draft-1",
      summary: { billing: 1 },
    });
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
    // operations, which `checkGuards` passes outright in `test` and — since
    // #327 P2b — asks a `mode` confirmation for in `live`, nothing more.
    // Exactly the isolation these tests want: the plan's own construction is
    // `publish-plan.test.ts`'s subject, and the empty plan is also the shape
    // the first real live publish will have (one revision, both modes
    // publish it, live Stripe already matches — verified 2026-09-03).
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

  it("refuses an operator holding billing but not publish-catalog, and audits the refusal", async () => {
    // The whole point of the risk verb: `billing` is the surface, and every
    // operator who can READ this catalog holds it.
    //
    // #409 task 3: publishing's own capability refusal is the highest-stakes
    // one in this file, and it used to write nothing — `checkOperatorCapability`
    // ran before `auditedOperation`. It now runs inside `operation`
    // (`withPublishWrite`), so this row exists.
    signIn(["billing"]);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({ ok: false, message: NO_PUBLISH_PERMISSION });
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "test (draft-1)",
      summary: { publish_catalog: 1 },
    });
  });

  // Pins the ordering decision (#409 task 3) for the publish half too: with
  // no database configured, `auditedOperation` refuses before `operation`
  // runs, so neither capability check inside it runs — the caller sees "the
  // publish could not be completed", not "no permission", even though the
  // capability would also have been refused. Breaks if either capability
  // check moves back outside `operation`.
  it("fails closed on AuditUnavailableError before either capability check, when no database is configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(undefined);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message:
        "The publish could not be completed. Check the publish log before retrying — some operations may already have run.",
    });
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

  it("refuses a live publish the operator never acknowledged as live", async () => {
    // #327 P2b: live is enabled and its `mode` breach is a CONFIRMATION, so
    // typing "live" alone is not enough — the operator must also have been
    // shown, and have acknowledged, the breach saying which account this
    // writes to. `acknowledged: []` is a caller that skipped that screen.
    signIn(["billing", "publish-catalog"]);

    const result = await publishAction("draft-1", "live", { typedMode: "live", acknowledged: [] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/changed since it was reviewed/);
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();
    expect(promotePublication).not.toHaveBeenCalled();

    // #409 task 2: a refused LIVE attempt is still the single most
    // interesting row in this file. The row must name the attempted mode —
    // "live", not "test" — and which rule refused it, and must NOT reuse a
    // successful publish's action name.
    const insert = lastAuditInsert();
    expect(insert.action).toBe("billing.catalog.publish.refused");
    expect(insert.action).not.toBe("billing.catalog.publish");
    expect(insert.summary).toEqual({ mode_live: 1, rule_mode: 1 });
  });

  it("observes live Stripe and publishes to it once the mode breach is acknowledged", async () => {
    // The behaviour #327 P2b exists to produce, and the two halves of it
    // that a deleted-guard implementation would also pass are asserted
    // separately below, so this test fails for the right reason:
    //
    //   1. Stripe IS read for live. `observeAndPlan` used to refuse the mode
    //      BEFORE `prices.list`, returning a plan built from no observation
    //      at all; a confirmation over an unobserved plan would be asking an
    //      operator to approve a blank page.
    //   2. The attempt opens against `mode: "live"` and carries the
    //      fingerprint of that observation — the field the short-circuited
    //      path structurally could not supply.
    signIn(["billing", "publish-catalog"]);
    vi.mocked(executePublish).mockResolvedValue({ outcome: "succeeded", operations: [] });

    const result = await publishAction("draft-1", "live", {
      typedMode: "live",
      acknowledged: ["mode"],
    });

    expect(result).toMatchObject({ ok: true, outcome: "succeeded", promoted: true });
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
    expect(readCatalogAmounts).toHaveBeenCalledWith("live", expect.anything());
    expect(startPublishAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionId: "draft-1",
        mode: "live",
        startedBy: "operator-1",
        // A real SHA-256 over the observation, not "" — the empty string is
        // what the refused path used to hand `startPublishAttempt` before
        // #411's minor 3 made it a type error to try.
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(promotePublication).toHaveBeenCalledWith("live", "draft-1", "operator-1");
    expect(lastAuditInsert()).toEqual({
      action: "billing.catalog.publish",
      target: "live (draft-1)",
      summary: { failed: 0, promoted: 1 },
    });
  });

  it("asks for NO extra acknowledgement on a routine test publish", async () => {
    // The regression that would put a confirmation in front of every
    // ordinary test publish: a `mode` breach raised for all modes rather
    // than for live. `CONFIRMED` acknowledges nothing, so if `checkGuards`
    // produced any breach for "test" this publish would be refused as
    // unreviewed instead of running.
    signIn(["billing", "publish-catalog"]);
    vi.mocked(executePublish).mockResolvedValue({ outcome: "succeeded", operations: [] });

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(startPublishAttempt).toHaveBeenCalledWith(expect.objectContaining({ mode: "test" }));
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

  // #409 task 2, restated for #327 P2b: `checkCurrencyCoverage` is now the
  // only rule that reaches the `"refused" in verdict` throw in `actions.ts`
  // (`mode` moved to the confirmation branch, which the live test above
  // covers). The rule name still has to survive into the audit row: the
  // source change that would make this fail is deleting
  // `verdict.refused.map((breach) => breach.rule)` from that throw, or
  // hardcoding a fixed rule list, which would collapse
  // `rule_currency_coverage` into whatever another test asserts.
  it("refuses a plan that would drop a currency, and names currency-coverage as the rule", async () => {
    signIn(["billing", "publish-catalog"]);
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_currency_drop`;
    // Draft matches the ancestor exactly (no intended change), but Stripe
    // carries a currency the draft no longer wants — `checkCurrencyCoverage`
    // refuses this unconditionally; there is no Stripe call that can remove
    // a `currency_options` entry (`publish-guards.ts`'s own header).
    vi.mocked(readCatalogAmounts).mockResolvedValue([amount(key, "usd", 1000)]);
    vi.mocked(readRevisionAmounts).mockResolvedValue([amount(key, "usd", 1000)]);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([
      price({
        lookup_key: key,
        currency: "usd",
        unit_amount: 1000,
        currency_options: { eur: { unit_amount: 700, tax_behavior: "unspecified" } },
      }),
    ]);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/lose currency "eur"/),
    });
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();

    const insert = lastAuditInsert();
    expect(insert.action).toBe("billing.catalog.publish.refused");
    expect(insert.action).not.toBe("billing.catalog.publish");
    expect(insert.summary).toEqual({ mode_test: 1, rule_currency_coverage: 1 });
  });

  // #409 task 2: the second throw site (`"requiresConfirmation" in verdict`,
  // an unacknowledged breach) — a plan the operator never had the chance to
  // review before this exact breach appeared. Deleting `unacknowledged.map(
  // (breach) => breach.rule)` from that throw, or reusing the mode test's
  // rule list, would make this assertion fail while the mode test still
  // passes — proof the two throw sites are independently covered.
  it("refuses a plan that changed since it was reviewed, and names the guard rule that changed", async () => {
    signIn(["billing", "publish-catalog"]);
    const key = `${MARK8LY_LOOKUP_KEY_PREFIX}k_magnitude_drop`;
    // Ancestor 1000, draft 200: an 80% move against the ancestor trips
    // `checkMagnitude` (25% threshold) — a CONFIRMATION rule, not a refusal.
    // `acknowledged: []` (via `CONFIRMED`) means the operator never
    // acknowledged it, so `publishAction` refuses rather than proceeding.
    vi.mocked(readCatalogAmounts).mockResolvedValue([amount(key, "usd", 1000)]);
    vi.mocked(readRevisionAmounts).mockResolvedValue([amount(key, "usd", 200)]);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([
      price({ lookup_key: key, currency: "usd", unit_amount: 1000 }),
    ]);

    const result = await publishAction("draft-1", "test", CONFIRMED);

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/changed since it was reviewed/),
    });
    expect(startPublishAttempt).not.toHaveBeenCalled();
    expect(executePublish).not.toHaveBeenCalled();

    const insert = lastAuditInsert();
    expect(insert.action).toBe("billing.catalog.publish.refused");
    expect(insert.action).not.toBe("billing.catalog.publish");
    expect(insert.summary).toEqual({ mode_test: 1, rule_magnitude: 1 });
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

  // The inverse of the test that used to live here. `observeAndPlan` once
  // refused the mode BEFORE reading Stripe, because a refused mode could not
  // pass whatever `prices.list` returned. #327 P2b turned live into a
  // CONFIRMATION, so that reasoning is gone: `AuthoringPanel`'s
  // `PublishSection` mounts this for `mode=live` precisely so the operator
  // can see the plan they are being asked to confirm, and an unobserved
  // plan would be a blank page with a confirmation attached to it.
  it("builds a real plan for live, and asks for confirmation rather than refusing", async () => {
    signIn(["billing"]);

    const result = await planPublishAction("draft-1", "live");

    expect(result.ok).toBe(true);
    expect(result.ok && result.plan.verdict).toMatchObject({
      ok: false,
      requiresConfirmation: [expect.objectContaining({ rule: "mode" })],
    });
    expect(result.ok && result.plan.verdict).not.toHaveProperty("refused");
    // All three reads happen for live now, and against LIVE — a plan built
    // from the test account's prices would be a confirmation about the wrong
    // Stripe account, which is the 2026-08-27 mix-up wearing a new hat.
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
    expect(readCatalogAmounts).toHaveBeenCalledWith("live", expect.anything());
    expect(readRevisionAmounts).toHaveBeenCalledWith("draft-1", expect.anything());
  });
});
