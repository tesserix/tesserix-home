import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { migrationsPendingMessage } from "@/lib/db-read-error";
import { PlatformApiError } from "@/lib/platform-api";
import type { CatalogRow, ParityWindowStatus, ModeLatestRun } from "@/lib/db/plan-catalog-repo";

const getCurrentSession = vi.fn();

// `hasCapability` itself is NOT mocked — same reasoning
// `crm/[organisation]/page.test.tsx` gives: a passing test here is evidence
// about the real capability decision, not a stand-in for it.
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: (...args: unknown[]) => getCurrentSession(...args),
}));

// Forces `canDraft`/`canPublish` to actually check roles rather than the
// pre-cutover "every session holds every capability" bypass — same reason
// `crm/[organisation]/page.test.tsx` does this. A `vi.fn()`, not a bare
// `() => true`, so the "pre-cutover bypass IS in effect" branch (the
// `!requiresCapability() || ...` short-circuit itself) can also be
// exercised, by overriding it back to `false` in an individual test.
const requiresCapability = vi.fn((..._args: unknown[]) => true);

vi.mock("@/lib/internal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/internal-access")>()),
  requiresCapability: (...args: unknown[]) => requiresCapability(...args),
}));

vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  isDatabaseConfigured: () => true,
}));

const readWindowStatus = vi.fn();
const readCatalogRows = vi.fn();
const readLatestRuns = vi.fn();
const readLivePublication = vi.fn();
const readRevisionRows = vi.fn();

vi.mock("@/lib/db/plan-catalog-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/plan-catalog-repo")>()),
  readWindowStatus: (...args: unknown[]) => readWindowStatus(...args),
  readCatalogRows: (...args: unknown[]) => readCatalogRows(...args),
  readLatestRuns: (...args: unknown[]) => readLatestRuns(...args),
  readLivePublication: (...args: unknown[]) => readLivePublication(...args),
  readRevisionRows: (...args: unknown[]) => readRevisionRows(...args),
}));

const currentDraft = vi.fn();
const latestPublishAttempt = vi.fn();
const operationsForAttempt = vi.fn();

vi.mock("@/lib/db/publish-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/publish-repo")>()),
  currentDraft: (...args: unknown[]) => currentDraft(...args),
  latestPublishAttempt: (...args: unknown[]) => latestPublishAttempt(...args),
  operationsForAttempt: (...args: unknown[]) => operationsForAttempt(...args),
}));

// The orphan check reaches Stripe for real (`stripePriceReader.listPrices`),
// which is exactly why it is its own independently-narrowed read on the page
// and exactly why it is stood in here: these tests are about WHEN the page
// asks the question, not about what Stripe answers. `orphans.test.ts` covers
// the answering.
const findOrphans = vi.fn();

vi.mock("@/lib/billing/orphans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/orphans")>()),
  findOrphans: (...args: unknown[]) => findOrphans(...args),
}));

// The write path itself is exercised by `actions.test.ts`; this page's own
// tests are about WHICH controls render for WHICH capability set, not about
// what a click on one of them ultimately does to Stripe.
const startDraftAction = vi.fn();
const discardDraftAction = vi.fn();
const planPublishAction = vi.fn();
const publishAction = vi.fn();

vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  startDraftAction: (...args: unknown[]) => startDraftAction(...args),
  discardDraftAction: (...args: unknown[]) => discardDraftAction(...args),
  planPublishAction: (...args: unknown[]) => planPublishAction(...args),
  publishAction: (...args: unknown[]) => publishAction(...args),
}));

import PlanCatalog, {
  ATTEMPT_SURFACE,
  CATALOG_SURFACE,
  OPERATIONS_SURFACE,
  ORPHANS_SURFACE,
  PUBLICATION_SURFACE,
  RUNS_SURFACE,
  WINDOW_SURFACE,
  attemptReadError,
  catalogReadError,
  operationsReadError,
  orphansReadError,
  publicationReadError,
  readCatalogMode,
  runsReadError,
  surfacedAttempt,
  windowReadError,
} from "./page";
import type { PublishAttempt } from "@/lib/db/publish-repo";

/**
 * The server half's pure functions — the part that can be tested without
 * standing up a React Server Component render, the same split
 * `billing/page.test.tsx` and `audit-log/page.test.tsx` make.
 */

describe("readCatalogMode", () => {
  it("defaults to live, per the task's instruction", () => {
    expect(readCatalogMode({})).toBe("live");
  });

  it("honours an explicit test or live", () => {
    expect(readCatalogMode({ mode: "test" })).toBe("test");
    expect(readCatalogMode({ mode: "live" })).toBe("live");
  });

  it("falls back to live on anything that is not a Stripe mode", () => {
    // An unrecognised or hand-edited `?mode=` must not throw and must not
    // silently show test data under a URL that says nothing about test.
    expect(readCatalogMode({ mode: "sandbox" })).toBe("live");
    expect(readCatalogMode({ mode: ["test", "live"] })).toBe("live");
  });
});

/** A rejection shaped like `pg` reporting a missing relation — the state of
 *  every environment where 0032-0035 have not been applied yet. */
const undefinedTable = () => Object.assign(new Error("relation does not exist"), { code: "42P01" });

describe("read errors — independent surfaces, independent narrowings", () => {
  // Each read goes through `dbReadError`, exactly like `audit-log`'s
  // `consoleReadError`: `tesserix-postgres`'s own messages are written for a
  // server log, not for an operator, and the un-migrated case must read as
  // "not set up yet" rather than `relation "plan_catalog_prices" does not
  // exist`.
  it("names the observation window's own surface in the migrations-pending copy", () => {
    const error = windowReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(WINDOW_SURFACE));
  });

  it("names the catalog table's own surface in the migrations-pending copy", () => {
    const error = catalogReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(CATALOG_SURFACE));
  });

  it("names the parity runs' own surface in the migrations-pending copy", () => {
    const error = runsReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(RUNS_SURFACE));
  });

  // The fourth read — task 2R. Same narrowing as the other three: a mode
  // with no publication yet is a normal `null` (see `readPublication`), never
  // an error, so this only ever fires for an actual read failure.
  it("names the publication's own surface in the migrations-pending copy", () => {
    const error = publicationReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(PUBLICATION_SURFACE));
  });

  it("leaves a genuine failure alone, rather than dressing it up as unmigrated", () => {
    const error = windowReadError(new PlatformApiError("connection reset", 503));
    expect(error?.unavailable).toBeUndefined();
  });

  it("leaves a genuine publication read failure alone too, rather than dressing it up as unmigrated", () => {
    // The exact case the brief warns about: a failed publication read must
    // not be mistaken for "migrations pending" when it is a real failure.
    const error = publicationReadError(new PlatformApiError("connection reset", 503));
    expect(error?.unavailable).toBeUndefined();
  });

  // The three surfaces this page grew when the publish outcome stopped living
  // only in `AuthoringPanel`'s React state. Each narrows on its own, for the
  // same reason the four above do: an operator staring at "something went
  // wrong" needs to know WHICH of seven reads went wrong.
  it("names the latest attempt's own surface in the migrations-pending copy", () => {
    const error = attemptReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(ATTEMPT_SURFACE));
  });

  it("names the orphan check's own surface in the migrations-pending copy", () => {
    const error = orphansReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(ORPHANS_SURFACE));
  });

  it("names the operations' own surface in the migrations-pending copy", () => {
    const error = operationsReadError(undefinedTable());
    expect(error?.unavailable?.message).toBe(migrationsPendingMessage(OPERATIONS_SURFACE));
  });

  it("passes null through for no error", () => {
    expect(windowReadError(null)).toBeNull();
  });
});

/**
 * Decision 1 of the persisted-outcome plan, as a pure function: only an
 * UNRESOLVED attempt is this surface's to tell. A succeeded one is already
 * told, durably and more honestly, by `readLivePublication` — who published
 * which revision, and when.
 */
describe("surfacedAttempt", () => {
  const ATTEMPT: PublishAttempt = {
    id: "attempt-1",
    revisionId: "draft-1",
    mode: "test",
    fingerprint: "fp-1",
    startedBy: "operator-1",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:05.000Z",
    outcome: "failed",
  };

  it("withholds a succeeded attempt — `readLivePublication` already tells that story", () => {
    expect(surfacedAttempt({ ...ATTEMPT, outcome: "succeeded" })).toBeNull();
  });

  it("surfaces a failed attempt", () => {
    expect(surfacedAttempt(ATTEMPT)?.id).toBe("attempt-1");
  });

  it("surfaces an aborted attempt", () => {
    expect(surfacedAttempt({ ...ATTEMPT, outcome: "aborted" })?.id).toBe("attempt-1");
  });

  it("surfaces an attempt that never recorded a verdict at all", () => {
    // The crash between `startPublishAttempt` and `finishPublishAttempt` —
    // precisely the crash that strands an orphan, so precisely the attempt
    // most worth showing.
    expect(surfacedAttempt({ ...ATTEMPT, finishedAt: null, outcome: null })?.id).toBe("attempt-1");
  });

  it("has nothing to surface for a mode that has never been published", () => {
    expect(surfacedAttempt(null)).toBeNull();
  });
});

/**
 * Task 9's own tests: the mounted authoring surface. `catalog-views.tsx`,
 * `draft-editor.tsx`, `publish-view.tsx` and `publish-outcome.tsx` are all
 * exercised for real here — only the DATA layer (the six reads above, plus
 * the four write-path actions) is stood in, the same split
 * `crm/[organisation]/page.test.tsx` makes for its own page-level tests.
 */
describe("the mounted authoring surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requiresCapability.mockReturnValue(true);
  });

  const WINDOW_STATUS: ParityWindowStatus = {
    days: 7,
    satisfied: true,
    modes: [
      { mode: "test", satisfied: true, days: [] },
      { mode: "live", satisfied: true, days: [] },
    ],
  };

  const RUNS: ModeLatestRun[] = [
    { mode: "test", run: null },
    { mode: "live", run: null },
  ];

  const PUBLISHED_ROW: CatalogRow = {
    lookupKey: "mark8ly_pro_monthly_developed_v1",
    plan: "pro",
    period: "monthly",
    tier: "developed",
    source: "mark8ly",
    currency: "usd",
    unitAmountMinor: 4900,
    taxBehavior: "exclusive",
  };

  const DRAFT_ROW: CatalogRow = { ...PUBLISHED_ROW, unitAmountMinor: 5900 };

  const FAILED_ATTEMPT: PublishAttempt = {
    id: "attempt-1",
    revisionId: "draft-1",
    mode: "test",
    fingerprint: "fp-1",
    startedBy: "operator-1",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:05.000Z",
    outcome: "failed",
  };

  function setUpSuccessfulReads() {
    readWindowStatus.mockResolvedValue(WINDOW_STATUS);
    readCatalogRows.mockResolvedValue([PUBLISHED_ROW]);
    readLatestRuns.mockResolvedValue(RUNS);
    readLivePublication.mockResolvedValue(null);
    // The ordinary state of both new reads: nobody has published this mode,
    // and Stripe holds no archived-but-active Price. Neither is a failure.
    latestPublishAttempt.mockResolvedValue(null);
    findOrphans.mockResolvedValue([]);
  }

  function signIn(roles: readonly string[]) {
    getCurrentSession.mockResolvedValue({
      sub: "operator-1",
      email: "op@tesserix.app",
      roles,
      iat: 0,
      exp: 0,
    });
  }

  async function renderCatalogPage(mode: "test" | "live" = "test") {
    render(await PlanCatalog({ searchParams: Promise.resolve({ mode }) }));
  }

  const READY_PLAN = {
    revisionId: "draft-1",
    mode: "test" as const,
    counts: {
      create_product: 0,
      create_price: 0,
      replace_price: 1,
      add_currency_option: 0,
      update_tax_behavior: 0,
      archive_price: 0,
      total: 1,
      intended: 1,
      driftCorrection: 0,
      unactionable: 0,
    },
    unactionable: [],
    verdict: { ok: true as const },
  };

  it("mounts the draft editor for an operator holding billing but withholds the publish control without publish-catalog", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue({ id: "draft-1", basedOn: "rev-0" });
    readRevisionRows.mockResolvedValue([DRAFT_ROW]);
    signIn(["billing"]);

    await renderCatalogPage();

    // The read-only catalog table (`catalog-views.tsx`) still renders.
    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    // The draft editor (`draft-editor.tsx`) is mounted and usable — its
    // subscriber-safety note is the one thing it always renders.
    expect(
      screen.getByText(/existing subscribers stay on the price they were created against/i),
    ).toBeInTheDocument();
    // No usable publish control: `PublishView`'s own "Review changes" button
    // never mounts, and `planPublishAction` — which would call Stripe — is
    // never even attempted for an operator who cannot see its result.
    expect(screen.queryByRole("button", { name: /review changes/i })).toBeNull();
    expect(planPublishAction).not.toHaveBeenCalled();
    // Withheld VISIBLY, with a reason — never silently hidden.
    expect(screen.getByText(/publishing is withheld here/i)).toBeInTheDocument();
    expect(screen.getByText(/publish-catalog capability/i)).toBeInTheDocument();
  });

  it("shows the publish control for an operator holding both billing and publish-catalog", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue({ id: "draft-1", basedOn: "rev-0" });
    readRevisionRows.mockResolvedValue([DRAFT_ROW]);
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(await screen.findByRole("button", { name: /review changes/i })).toBeInTheDocument();
    expect(planPublishAction).toHaveBeenCalledWith("draft-1", "test");
  });

  it("grants both draft and publish for a role-less session under the pre-cutover bypass, exactly as canDraft does", async () => {
    // The branch `requiresCapability: () => true` permanently hides: with
    // the bypass actually in effect (`google` provider, no roles claim),
    // `canPublish` must take the SAME `!requiresCapability() || ...`
    // shortcut `canDraft` does — never gated behind `canDraft` first — so a
    // role-less session sees publishing exactly like `crm/[organisation]`'s
    // `canHardDelete` does.
    requiresCapability.mockReturnValue(false);
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue({ id: "draft-1", basedOn: "rev-0" });
    readRevisionRows.mockResolvedValue([DRAFT_ROW]);
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
    signIn([]);

    await renderCatalogPage();

    expect(await screen.findByRole("button", { name: /review changes/i })).toBeInTheDocument();
    expect(planPublishAction).toHaveBeenCalledWith("draft-1", "test");
    expect(screen.queryByText(/publishing is withheld here/i)).toBeNull();
  });

  it("renders the whole surface when there is no draft at all — the common case", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a draft/i })).toBeInTheDocument();
    expect(readRevisionRows).not.toHaveBeenCalled();
    expect(planPublishAction).not.toHaveBeenCalled();
  });

  it("narrows a failed draft read independently — the catalog table and the observation window still render", async () => {
    setUpSuccessfulReads();
    currentDraft.mockRejectedValue(new PlatformApiError("connection reset", 503));
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    // The catalog table and the observation window read cleanly and must
    // not be dressed up as broken by the draft read's own failure.
    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Observation window" })).toBeInTheDocument();
    // The draft section itself shows a genuine failure — never a draft
    // editor built on nothing, and never dressed up as "no draft yet".
    expect(screen.queryByRole("button", { name: /start a draft/i })).toBeNull();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("refuses live from the mounted surface, with the reason shown — never hidden", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue({ id: "draft-1", basedOn: "rev-0" });
    readRevisionRows.mockResolvedValue([DRAFT_ROW]);
    planPublishAction.mockResolvedValue({
      ok: true,
      plan: {
        ...READY_PLAN,
        mode: "live",
        verdict: {
          ok: false,
          refused: [
            {
              rule: "mode",
              message: 'Publishing to Stripe mode "live" is refused in v1.',
            },
          ],
        },
      },
    });
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage("live");

    expect(planPublishAction).toHaveBeenCalledWith("draft-1", "live");
    // `PublishView`'s own live-refusal copy — shown, not hidden.
    expect(
      await screen.findByText(/live publishing is not enabled/i),
    ).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: /review changes/i });
    expect(confirmButton).toBeInTheDocument();
    // The control stays reachable (so the reason is announced to a
    // screen-reader operator too) but the actual publish stays refused: the
    // dialog it opens can never enable its own confirm button while `mode`
    // is a refused rule — see `publish-view.tsx`'s `confirmDisabled`.
  });

  /**
   * The persisted publish outcome and the orphan check: two more independent
   * reads and one dependent one. The narrowing rule is the same rule the
   * other five obey — a failure in any of them must land in its own
   * `SurfaceState` and leave the catalog table standing.
   */
  it("narrows a failed latest-attempt read independently — the catalog table and the window still render", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockRejectedValue(new PlatformApiError("connection reset", 503));
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Observation window" })).toBeInTheDocument();
    // No attempt means no id, so there is nothing to read operations FOR —
    // the dependent read is simply never attempted, exactly as
    // `readRevisionRows` is not attempted when there is no draft.
    expect(operationsForAttempt).not.toHaveBeenCalled();
  });

  it("narrows a failed orphan read independently — the catalog renders and the attempt's outcome is still assembled", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockResolvedValue(FAILED_ATTEMPT);
    operationsForAttempt.mockResolvedValue([]);
    findOrphans.mockRejectedValue(new PlatformApiError("stripe unavailable", 503));
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    // A Stripe outage degrades to "orphan check unavailable" and nothing
    // else: the attempt read is a sibling in the same `allSettled`, so it
    // still resolved and its dependent operations read still ran.
    expect(operationsForAttempt).toHaveBeenCalledWith("attempt-1");
  });

  it("narrows a failed operations read independently — it does not take the attempt read down with it", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockResolvedValue(FAILED_ATTEMPT);
    operationsForAttempt.mockRejectedValue(new PlatformApiError("connection reset", 503));
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(screen.getByRole("tablist", { name: "Plan catalog, by plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Observation window" })).toBeInTheDocument();
    // The attempt itself read cleanly, and the orphan check — a sibling, not
    // a child — ran regardless.
    expect(findOrphans).toHaveBeenCalledWith("test");
  });

  it("reads the operations of an unresolved latest attempt", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockResolvedValue(FAILED_ATTEMPT);
    operationsForAttempt.mockResolvedValue([]);
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(latestPublishAttempt).toHaveBeenCalledWith("test");
    expect(operationsForAttempt).toHaveBeenCalledWith("attempt-1");
  });

  it("reads no operations for a succeeded latest attempt — Decision 1", async () => {
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockResolvedValue({ ...FAILED_ATTEMPT, outcome: "succeeded" });
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    // A succeeded attempt is not this surface's story to tell, so its
    // operations are not even fetched — see `surfacedAttempt`.
    expect(operationsForAttempt).not.toHaveBeenCalled();
  });

  it("checks for orphans even when the latest attempt succeeded — Decision 2", async () => {
    // THE anti-regression test. `findOrphans` is mode-scoped, not
    // attempt-scoped: an orphan outlives the attempt that stranded it and
    // survives a later successful publish. Folding this read back under the
    // attempt gate would make the exact failure this whole surface exists to
    // reveal permanently invisible — and would look deliberate while doing
    // it.
    setUpSuccessfulReads();
    currentDraft.mockResolvedValue(null);
    latestPublishAttempt.mockResolvedValue({ ...FAILED_ATTEMPT, outcome: "succeeded" });
    findOrphans.mockResolvedValue([
      { priceId: "price_stranded", lookupKey: null, source: "mark8ly" },
    ]);
    signIn(["billing", "publish-catalog"]);

    await renderCatalogPage();

    expect(findOrphans).toHaveBeenCalledWith("test");
  });
});
