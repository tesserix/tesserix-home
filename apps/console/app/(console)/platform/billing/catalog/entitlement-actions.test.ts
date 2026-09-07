import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchProductEntitlements: vi.fn(),
}));
vi.mock("@/lib/db/plan-catalog-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/plan-catalog-repo")>()),
  writeEntitlements: vi.fn(),
}));
// The parity RUN is stubbed and the parity DECISION is not: `parity-run.ts` is
// #146's own module with its own tests, and re-deriving its four outcomes here
// would test that module twice and this action's handling of them not at all.
// What is under test is the mapping from its two-field result onto the five
// answers an operator can act on.
vi.mock("@/lib/billing/parity-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/parity-run")>()),
  runEntitlementParityCheck: vi.fn(),
}));
// `auditedOperation` itself is NOT mocked — only its leaf dependency — the
// discipline `promo-actions.test.ts` and `actions.test.ts` both state
// (Ruling 15): a passing test here is evidence about the real audit control
// rather than about a stand-in for it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { writeEntitlements, type EntitlementRow } from "@/lib/db/plan-catalog-repo";
import { isDatabaseConfigured, tesserixQuery } from "@/lib/db/tesserix";
import { fetchProductEntitlements } from "@/lib/platform-api";
import { runEntitlementParityCheck } from "@/lib/billing/parity-run";
import type { EntitlementParityRun, ParityOutcome } from "@/lib/db/plan-catalog-repo";
import type { EntitlementMatrix, EntitlementPage } from "@/lib/billing";
import { runEntitlementParityAction, seedEntitlementsAction } from "./entitlement-actions";

/**
 * #146 T4's server half — the seed.
 *
 * ══ NOT ONE FEATURE OR PLAN NAME FROM PLANGATE APPEARS IN THIS FILE ══
 *
 * The fixtures below are `feature_0`…`feature_25` and `plan_a`…`plan_d`,
 * and the synthetic names are the assertion, not a shortcut. This action's
 * whole claim is that it DERIVES the matrix from what the enforcing product
 * reports; a fixture spelling `stores` and `pro` would pass just as well
 * against an action that had those names compiled into it, which is the copy
 * this task exists to avoid making. Nothing here can pass unless the action
 * reads the names off the response.
 *
 * The counts — 26 and 4 — ARE stated, because they are what the completeness
 * guard is: 0052's CHECK lists 26 features and 4 plans, so a matrix with
 * fewer is a read that did not fully happen. That is a size, not a value.
 */

const FEATURE_COUNT = 26;
const PLAN_NAMES = ["plan_a", "plan_b", "plan_c", "plan_d"] as const;
const FEATURE_NAMES = Array.from({ length: FEATURE_COUNT }, (_, i) => `feature_${i}`);

/** A cell value that is different for every (plan, feature) pair, so a test
 *  asserting one row cannot pass on a row the action put somewhere else. */
function cellValue(planIndex: number, featureIndex: number): number {
  return planIndex * 100 + featureIndex;
}

function matrixFor(
  source: string,
  options: { readonly features?: readonly string[]; readonly plans?: readonly string[] } = {},
): EntitlementMatrix {
  const features = options.features ?? FEATURE_NAMES;
  const plans = options.plans ?? PLAN_NAMES;
  return {
    source,
    catalogMode: "test",
    features,
    plans: Object.fromEntries(
      plans.map((plan, p) => [
        plan,
        Object.fromEntries(
          features.map((feature) => [
            feature,
            cellValue(p, FEATURE_NAMES.indexOf(feature)),
          ]),
        ),
      ]),
    ),
  };
}

function page(
  data: readonly EntitlementMatrix[],
  failures: EntitlementPage["failures"] = [],
): EntitlementPage {
  return { data, failures };
}

const REVISION = "11111111-1111-1111-1111-111111111111";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "operator-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The rows `writeEntitlements` was HANDED — the request, not the outcome. A
 *  stub that accepts anything makes "did it write the right matrix?"
 *  unaskable, which is the failure this milestone already paid for once. */
function writtenRows(): readonly EntitlementRow[] {
  const call = vi.mocked(writeEntitlements).mock.calls.at(-1);
  if (!call) throw new Error("writeEntitlements was never called");
  return call[2];
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

/** One recorded entitlement run, shaped as `parity-run.ts` hands it back. The
 *  publication id is present for every outcome that 0036 requires one for and
 *  absent for the two that forbid it, so a fixture cannot assert an outcome the
 *  database would refuse to store. */
function parityRun(
  outcome: ParityOutcome,
  differences: EntitlementParityRun["differences"] = [],
): EntitlementParityRun {
  return {
    mode: "test",
    source: "mark8ly",
    outcome,
    differences,
    error: outcome === "failed" ? "Error: upstream refused" : null,
    publicationId:
      outcome === "failed" || outcome === "not_bootstrapped"
        ? null
        : "22222222-2222-2222-2222-222222222222",
  };
}

/** Two cells that disagree, enough for a `differences` run to carry a count
 *  the action has to report rather than round to "not clean". */
const TWO_DIFFERENCES = [
  { plan: "plan_a", feature: "feature_0", console: 1, product: 2 },
  { plan: "plan_b", feature: "feature_1", console: 0, product: -1 },
] as unknown as EntitlementParityRun["differences"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
  vi.mocked(writeEntitlements).mockResolvedValue(undefined);
  vi.mocked(fetchProductEntitlements).mockResolvedValue(page([matrixFor("mark8ly")]));
  vi.mocked(runEntitlementParityCheck).mockResolvedValue({
    run: parityRun("clean"),
    notRecorded: null,
  });
  signIn(["billing"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seedEntitlementsAction", () => {
  it("writes every cell of the product's matrix, derived from the response", async () => {
    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result).toEqual({ ok: true });
    const rows = writtenRows();
    // 26 features x 4 plans. The number is asserted rather than the row list,
    // because a matrix that seeded 103 of 104 cells is exactly the partial
    // seed this action refuses — and one missing row is invisible in a
    // containment check.
    expect(rows).toHaveLength(FEATURE_COUNT * PLAN_NAMES.length);
    expect(rows).toEqual(
      expect.arrayContaining([
        { plan: "plan_a", feature: "feature_0", value: cellValue(0, 0) },
        { plan: "plan_d", feature: "feature_25", value: cellValue(3, 25) },
      ]),
    );
    expect(new Set(rows.map((row) => `${row.plan}/${row.feature}`)).size).toBe(
      FEATURE_COUNT * PLAN_NAMES.length,
    );
  });

  it("revalidates the catalog surface and records one audit row", async () => {
    await seedEntitlementsAction(REVISION, "mark8ly");

    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
    const audit = lastAuditInsert();
    expect(audit.action).toBe("billing.entitlements.seed");
    expect(audit.target).toBe(REVISION);
    expect(audit.summary).toMatchObject({ seeded: FEATURE_COUNT * PLAN_NAMES.length });
  });

  it("selects the matrix whose source matches, never data[0]", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([matrixFor("kora"), matrixFor("mark8ly")]),
    );

    await seedEntitlementsAction(REVISION, "mark8ly");

    // `kora`'s matrix carries the same synthetic feature names, so the
    // assertion cannot be that the values differ — it is that the ONE row
    // asked for was found at index 1. A positional read would have taken
    // index 0 and still produced 104 plausible rows.
    expect(vi.mocked(writeEntitlements).mock.calls.at(-1)?.[1]).toBe("mark8ly");
    expect(writtenRows()).toHaveLength(FEATURE_COUNT * PLAN_NAMES.length);
  });

  it("writes NOTHING when the product reports fewer than 26 features", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([matrixFor("mark8ly", { features: FEATURE_NAMES.slice(0, FEATURE_COUNT - 1) })]),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the product reports fewer than four plans", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([matrixFor("mark8ly", { plans: PLAN_NAMES.slice(0, 3) })]),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  // The count guard on its own would pass this: 26 features declared, 4 plans
  // present, and one plan holding 25 cells. 103 rows would be written and the
  // missing one would read as agreement forever after.
  it("writes NOTHING when one plan is missing a cell the feature list declares", async () => {
    const complete = matrixFor("mark8ly");
    const { feature_7: _dropped, ...shortPlan } = complete.plans.plan_c;
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([{ ...complete, plans: { ...complete.plans, plan_c: shortPlan } }]),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  // A `failures` entry is a read that DID NOT HAPPEN. It is not an empty
  // matrix, and seeding zeros for it would assert that the product entitles
  // nothing — a policy nobody wrote, which would then compare parity-clean.
  it("writes NOTHING when the source is in failures", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([], [{ source: "mark8ly", message: "connection refused" }]),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  // Both halves of the same response: a matrix present AND a failure named.
  // The failure wins — a product that answered partially answered nothing
  // this seed can trust.
  it("writes NOTHING when the source is in failures even if a matrix is also present", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(
      page([matrixFor("mark8ly")], [{ source: "mark8ly", message: "partial read" }]),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  it("writes NOTHING when no matrix carries the requested source", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(page([matrixFor("kora")]));

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  it("refuses an operator without the billing capability, and writes nothing", async () => {
    signIn(["support"]);

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(writeEntitlements).not.toHaveBeenCalled();
  });

  // The database is the rule. A refusal comes back as an operator sentence
  // naming what happened — never the driver's text, and never repaired into
  // a success.
  it("surfaces a constraint refusal without repairing the row", async () => {
    const violation = Object.assign(
      new Error(
        `error: new row for relation "plan_catalog_entitlements" violates check constraint ` +
          `"plan_catalog_entitlements_value_is_a_known_sentinel_or_cap"`,
      ),
      { constraint: "plan_catalog_entitlements_value_is_a_known_sentinel_or_cap" },
    );
    vi.mocked(writeEntitlements).mockRejectedValue(violation);

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toContain("plan_catalog_entitlements");
    expect(result.message).toMatch(/sentinel|-2/);
  });

  it("says so when the revision already carries this product's entitlements", async () => {
    vi.mocked(writeEntitlements).mockRejectedValue(
      Object.assign(
        new Error(
          `error: duplicate key value violates unique constraint "plan_catalog_entitlements_pkey"`,
        ),
        { constraint: "plan_catalog_entitlements_pkey" },
      ),
    );

    const result = await seedEntitlementsAction(REVISION, "mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/already/i);
  });

  it("does not revalidate a surface nothing was written to", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(page([matrixFor("kora")]));

    await seedEntitlementsAction(REVISION, "mark8ly");

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * #146's caller for the parity comparator.
 *
 * The distinction every test below is built around: `runEntitlementParityCheck`
 * reports "no run could be attributed" and "the row could not be written"
 * through ONE field, and a caller that read only that field would report both
 * as the same thing — and, worse, a caller that read only `run` would report an
 * unattributable attempt as a run that answered. The two are separated by
 * `run === null`, and several of these tests fail if that discriminator is
 * dropped.
 */
describe("runEntitlementParityAction", () => {
  it("reports a recorded clean run as answered, and re-reads the surface", async () => {
    const result = await runEntitlementParityAction("mark8ly");

    expect(result).toEqual({
      ok: true,
      outcome: "answered",
      runOutcome: "clean",
      differences: 0,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("reports how many cells disagreed, not merely that some did", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: parityRun("differences", TWO_DIFFERENCES),
      notRecorded: null,
    });

    const result = await runEntitlementParityAction("mark8ly");

    expect(result).toEqual({
      ok: true,
      outcome: "answered",
      runOutcome: "differences",
      differences: 2,
    });
  });

  // Zero console rows is a different fact from agreement. A row was written and
  // the window counts it, so it is `answered` — but `runOutcome` has to say
  // WHICH, or the surface cannot tell "not seeded" from "seeded and clean" and
  // the permanently-red 104-difference signal this outcome exists to prevent
  // comes back as a permanently-green one.
  it("keeps not_bootstrapped distinguishable from clean", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: parityRun("not_bootstrapped"),
      notRecorded: null,
    });

    const result = await runEntitlementParityAction("mark8ly");

    expect(result).toEqual({
      ok: true,
      outcome: "answered",
      runOutcome: "not_bootstrapped",
      differences: 0,
    });
  });

  // A `failed` row IS evidence — the check ran, could not complete, and said so
  // in a row the window can read. It is not `unrecordable`.
  it("reports a recorded failed run as check-failed, and still re-reads the surface", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: parityRun("failed"),
      notRecorded: null,
    });

    const result = await runEntitlementParityAction("mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("check-failed");
    // The stored reason is what the surface renders; the row landed, so it has
    // something new to read.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  // ══ THE DISTINCTION THIS ACTION EXISTS TO KEEP ══
  //
  // Nothing was written to `plan_catalog_parity_runs`. "We could not check"
  // must never read as "we checked", so this is neither `answered` nor a
  // recorded outcome of any kind.
  it("reports an unattributable attempt as its own outcome, never as answered", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: null,
      notRecorded: "mark8ly did not answer with its matrix",
    });

    const result = await runEntitlementParityAction("mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("unattributable");
  });

  it("does not re-read a surface no run was recorded to", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: null,
      notRecorded: "mark8ly did not answer with its matrix",
    });

    await runEntitlementParityAction("mark8ly");

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // The reason is `sanitizeReason`'d but still internal text — a transport
  // failure naming an internal host, a driver message naming the role. It is
  // logged, never shown, the same split the seed's refusals make.
  it("does not show the operator the internal reason", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: null,
      notRecorded: "Error: connect ECONNREFUSED platform-api.internal:8080",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runEntitlementParityAction("mark8ly");

    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toContain("ECONNREFUSED");
    expect(result.message).not.toContain("platform-api.internal");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  // The third case the two-outcome reading misses entirely: the comparison
  // HAPPENED and its row did not land. Distinct from `unattributable` (no
  // comparison) and from `check-failed` (a row exists saying so).
  it("separates a run whose row could not be written from one that was never attributed", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: parityRun("clean"),
      notRecorded: "Error: relation does not exist",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runEntitlementParityAction("mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("unrecordable");
    // And NOT reported as the clean run it decided: the row is the evidence,
    // and there is no row.
    expect(revalidatePath).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("says a run that cannot be recorded is not a run when there is no database", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const result = await runEntitlementParityAction("mark8ly");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("unrecordable");
    expect(runEntitlementParityCheck).not.toHaveBeenCalled();
  });

  it("refuses an operator without the billing capability, and runs no check", async () => {
    signIn(["support"]);

    const result = await runEntitlementParityAction("mark8ly");

    expect(result).toEqual({ ok: false, outcome: "not-run", message: NO_PERMISSION });
    expect(runEntitlementParityCheck).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never seeds — the comparator's only caller here is the check", async () => {
    vi.mocked(runEntitlementParityCheck).mockResolvedValue({
      run: parityRun("not_bootstrapped"),
      notRecorded: null,
    });

    await runEntitlementParityAction("mark8ly");

    // A `not_bootstrapped` result that seeded would make parity seed from the
    // product and then compare against the product — agreeing forever, by
    // construction.
    expect(writeEntitlements).not.toHaveBeenCalled();
    expect(fetchProductEntitlements).not.toHaveBeenCalled();
  });

  describe("the audit row", () => {
    it("records what the run produced, under a target naming the product", async () => {
      await runEntitlementParityAction("mark8ly");

      const audit = lastAuditInsert();
      expect(audit.action).toBe("billing.entitlements.parity.run");
      expect(audit.target).toBe("entitlements/mark8ly");
      expect(audit.summary).toMatchObject({
        recorded: 1,
        unattributable: 0,
        unrecordable: 0,
        outcome_clean: 1,
        differences: 0,
        source_mark8ly: 1,
      });
    });

    // The audit trail carries the same distinction the result does. An auditor
    // asking "was this checked?" must not have to infer it from an absent key.
    it("marks an unattributable attempt as recorded nothing, not as a clean run", async () => {
      vi.mocked(runEntitlementParityCheck).mockResolvedValue({
        run: null,
        notRecorded: "mark8ly did not answer with its matrix",
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      await runEntitlementParityAction("mark8ly");

      const audit = lastAuditInsert();
      expect(audit.action).toBe("billing.entitlements.parity.run");
      expect(audit.summary).toMatchObject({
        recorded: 0,
        unattributable: 1,
        unrecordable: 0,
      });
      // No outcome key at all: nothing was decided, so there is no outcome to
      // name. A row claiming `outcome_clean: 1` here would be the collapse.
      expect(audit.summary).not.toHaveProperty("outcome_clean");
      expect(audit.summary).not.toHaveProperty("outcome_not_bootstrapped");
      logged.mockRestore();
    });

    it("marks a run whose row did not land as unrecordable, not as recorded", async () => {
      vi.mocked(runEntitlementParityCheck).mockResolvedValue({
        run: parityRun("differences", TWO_DIFFERENCES),
        notRecorded: "Error: relation does not exist",
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      await runEntitlementParityAction("mark8ly");

      expect(lastAuditInsert().summary).toMatchObject({
        recorded: 0,
        unattributable: 0,
        unrecordable: 1,
        outcome_differences: 1,
        differences: 2,
      });
      logged.mockRestore();
    });

    // The refusal is audited too — through `auditedOperation`'s own
    // `capability.refused` path (#409), which is what the wrapper buys and why
    // the capability check lives inside `operation` rather than ahead of it.
    it("records a capability refusal rather than leaving it out of the trail", async () => {
      signIn(["support"]);

      await runEntitlementParityAction("mark8ly");

      expect(lastAuditInsert().action).toBe("capability.refused");
    });
  });
});
