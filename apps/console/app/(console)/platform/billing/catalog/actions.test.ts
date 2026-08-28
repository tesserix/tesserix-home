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
import { createDraftFrom, discardDraft, setDraftAmount } from "@/lib/db/publish-repo";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { discardDraftAction, setAmountAction, startDraftAction } from "./actions";

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
});
