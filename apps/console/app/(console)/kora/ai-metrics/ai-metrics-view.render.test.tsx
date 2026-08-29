import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// `useUrlFilters` (part C's search + activity toggles) reads the router,
// which jsdom has no app-router context for. Mocked exactly as
// `food-index.render.test.tsx` mocks it — this surface uses the same
// FilterBar. `getSearchParams`/`setSearchParams` are hoisted so individual
// tests can simulate a filtered URL without re-mocking the module.
//
// `router.replace` is a spy, NOT wired back into `getSearchParams` — same as
// `filter-bar.url-filters.test.tsx`. Next.js itself is what turns a
// `router.replace` call into a re-render with new `searchParams`; a jsdom
// unit test has no router to do that, so a filter's effect on the rendered
// table is asserted by pre-setting the URL via `setSearchParams` and
// rendering fresh, while the search box's WIRING (typing produces the right
// `router.replace` call) is asserted separately via the spy.
const { getSearchParams, setSearchParams, replace } = vi.hoisted(() => {
  let params = new URLSearchParams();
  return {
    getSearchParams: () => params,
    setSearchParams: (next: URLSearchParams) => {
      params = next;
    },
    replace: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/kora/ai-metrics",
  useSearchParams: () => getSearchParams(),
}));

afterEach(() => {
  setSearchParams(new URLSearchParams());
  replace.mockReset();
});

function pushedQuery(call = 0): URLSearchParams {
  const [url] = replace.mock.calls[call] as [string];
  return new URLSearchParams(url.split("?")[1] ?? "");
}

import type { EntityRecord } from "@/lib/entities";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import type { PagerLinks } from "../entity-page";
import { AiMetricsView, type AiMetricsViewProps } from "./ai-metrics-view";

// The real ten kinds `resolveoutcome.AllKinds` declares (kora's
// `docs/resolution-outcomes.md`), zero-filled the way Kora actually sends
// them — not invented placeholder names, so part D's grouping tests exercise
// the real vocabulary.
const METRICS: KoraAiMetrics = {
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: {
    attempts: 42,
    needsHuman: 2,
    byKind: {
      cache: 20,
      alias: 3,
      resolved: 15,
      weak_match: 2,
      below_floor: 1,
      no_match: 1,
      decomposed: 0,
      budget: 0,
      error: 0,
      transcript_blank: 0,
    },
    firstTryRatePct: 78.5,
  },
  users: [
    {
      userId: "u1",
      attempts: 4,
      resolves: 3,
      corrections: 1,
      budgetRefusals: 0,
      aiCalls: 4,
      lastActivityAt: "2026-08-27T10:00:00Z",
    },
    {
      userId: "u2",
      attempts: 1,
      resolves: 0,
      corrections: 0,
      budgetRefusals: 1,
      aiCalls: 1,
    },
  ],
};

const PAGER: PagerLinks = { precedingCount: 0, nextHref: null, previousHref: null };

// Empty by default: most tests here are not exercising the name join, and an
// empty directory is the honest "no page of kora users was available yet"
// shape — every row falls back to its raw id, same as the pre-join behaviour
// these existing tests already assert on (`screen.getByText("u1")`, etc.).
const EMPTY_DIRECTORY: ReadonlyMap<string, EntityRecord> = new Map();

const BASE: AiMetricsViewProps = {
  metrics: METRICS,
  pager: PAGER,
  pagination: { page: 1, limit: 50, total: 2 },
  state: { kind: "ready" },
  reauthReturnTo: "/kora/ai-metrics",
  userDirectory: EMPTY_DIRECTORY,
};

function renderView(overrides: Partial<AiMetricsViewProps> = {}) {
  return render(<AiMetricsView {...BASE} {...overrides} />);
}

describe("AiMetricsView — the window", () => {
  // The window is a real datum, not chrome — a reader must know what period
  // the numbers below it cover.
  it("states both ends of the window", () => {
    renderView();
    expect(screen.getByText(/2026-08-01T00:00:00Z/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-28T00:00:00Z/)).toBeInTheDocument();
  });
});

describe("AiMetricsView — outcomes", () => {
  it("renders attempts, needs human, and a measured first-try rate", () => {
    renderView();
    const outcomes = screen.getByRole("region", { name: "Outcomes" });
    expect(within(outcomes).getByText("42")).toBeInTheDocument();
    expect(within(outcomes).getByText("2")).toBeInTheDocument();
    expect(within(outcomes).getByText("79%")).toBeInTheDocument();
  });

  // Reuses the overview's own `formatFirstTryRate` — the one place this
  // field is turned into copy — rather than re-deriving the rule here.
  it("renders 'Not measured' rather than 0% when the rate is absent", () => {
    renderView({
      metrics: {
        ...METRICS,
        outcomes: { ...METRICS.outcomes, firstTryRatePct: undefined },
      },
    });
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });
});

describe("AiMetricsView — by kind", () => {
  // Kora zero-fills `by_kind` across every kind it measures. A kind dropped
  // because its count is 0 would hide that Kora measured it and found none —
  // a different fact from not measuring it at all.
  // The fixture zero-fills four: decomposed, budget, error, transcript_blank.
  it("renders every kind, including four with a zero count", () => {
    renderView();
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    expect(within(kindsSection).getByText("cache")).toBeInTheDocument();
    expect(within(kindsSection).getByText("20")).toBeInTheDocument();
    expect(within(kindsSection).getByText("decomposed")).toBeInTheDocument();
    expect(within(kindsSection).getByText("error")).toBeInTheDocument();
    expect(within(kindsSection).getByText("transcript blank")).toBeInTheDocument();
    expect(kindsSection.textContent).toMatch(/decomposed/);
  });

  // Grouped by what an operator does about them, not declaration order.
  it("groups the ten kinds into needs attention / succeeded / degraded / blocked", () => {
    renderView();
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    expect(within(kindsSection).getByText("Needs attention")).toBeInTheDocument();
    expect(within(kindsSection).getByText("Succeeded")).toBeInTheDocument();
    expect(within(kindsSection).getByText("Degraded")).toBeInTheDocument();
    expect(within(kindsSection).getByText("Blocked")).toBeInTheDocument();
  });

  // `Kind.NeedsHuman()` in kora returns true for exactly these two — see
  // resolveoutcome/model.go. Everything else has no console destination
  // today, so it must not be linked.
  it("links only no_match and below_floor to the kora-filtered inbox", () => {
    renderView();
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    const noMatchLink = within(kindsSection).getByRole("link", { name: /no match/i });
    expect(noMatchLink).toHaveAttribute("href", "/platform/inbox?source=kora");
    const belowFloorLink = within(kindsSection).getByRole("link", { name: /below floor/i });
    expect(belowFloorLink).toHaveAttribute("href", "/platform/inbox?source=kora");

    // The other eight have no inbox destination — linking them would ship
    // eight dead ends.
    for (const kind of ["cache", "alias", "resolved", "decomposed", "weak match", "budget", "error", "transcript blank"]) {
      expect(within(kindsSection).queryByRole("link", { name: new RegExp(`^${kind}$`, "i") })).toBeNull();
    }
  });

  // `no_match` is an index gap (kora: "high" severity in the inbox);
  // `below_floor` is a near-miss ("normal"). They must not read as
  // equivalent, and no_match sorts first within the group.
  it("orders no_match ahead of below_floor and marks it more severe", () => {
    renderView();
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    const text = kindsSection.textContent ?? "";
    expect(text.indexOf("no match")).toBeLessThan(text.indexOf("below floor"));
    expect(within(kindsSection).getByText("high")).toBeInTheDocument();
  });

  // An unrecognised kind (a future addition to kora's vocabulary, or a test
  // fixture using one) is rendered rather than silently dropped — the same
  // "unknown means unstyled/verbatim, never hidden" rule `inbox-queue.tsx`
  // applies to `kind` and `severity`.
  it("renders a kind this build has never seen under its own group rather than dropping it", () => {
    renderView({
      metrics: {
        ...METRICS,
        outcomes: { ...METRICS.outcomes, byKind: { ...METRICS.outcomes.byKind, mystery: 5 } },
      },
    });
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    expect(within(kindsSection).getByText("mystery")).toBeInTheDocument();
    expect(within(kindsSection).getByText("Other")).toBeInTheDocument();
  });
});

describe("AiMetricsView — users", () => {
  it("renders every user's counters", () => {
    renderView();
    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("u2")).toBeInTheDocument();
    // u1's counters: attempts 4, resolves 3, corrections 1, budget refusals 0, ai calls 4.
    expect(screen.getByText("2026-08-27T10:00:00Z")).toBeInTheDocument();
  });

  // `last_activity_at` is optional in the same way `first_try_rate_pct` is:
  // absent must render as absent, never as "Never" or an invented instant.
  it("renders a user with no last activity honestly, never as 'Never'", () => {
    renderView();
    expect(screen.queryByText(/never/i)).toBeNull();
  });

  it("shows the pager above the user table", () => {
    renderView({
      pager: { precedingCount: 0, nextHref: "/kora/ai-metrics?page=2", previousHref: null },
      pagination: { page: 1, limit: 1, total: 5 },
    });
    expect(screen.getByRole("link", { name: /next page of users/i })).toHaveAttribute(
      "href",
      "/kora/ai-metrics?page=2",
    );
  });

  it("says plainly when no user acted in this window, without hiding the outcomes above it", () => {
    renderView({ metrics: { ...METRICS, users: [] } });
    expect(screen.getByText(/no users in this window/i)).toBeInTheDocument();
    // The outcomes tiles are still there — an empty user table is not a
    // reason to blank the rest of the page.
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

describe("AiMetricsView — user identity", () => {
  const RAW_ID = "ce9afd1e-2c5f-4e21-83e3-540a85479ea7";
  const MATCHED_METRICS: KoraAiMetrics = {
    ...METRICS,
    users: [
      {
        userId: RAW_ID,
        attempts: 4,
        resolves: 3,
        corrections: 1,
        budgetRefusals: 0,
        aiCalls: 4,
      },
    ],
  };
  const MATCHED_ENTITY: EntityRecord = {
    id: RAW_ID,
    source: "kora",
    type: "users",
    label: "mahesh",
    sublabel: "mahesh@example.com",
  };

  it("renders the matched user's label and sublabel instead of the raw id", () => {
    renderView({
      metrics: MATCHED_METRICS,
      userDirectory: new Map([[RAW_ID, MATCHED_ENTITY]]),
    });
    expect(screen.getByText("mahesh")).toBeInTheDocument();
    expect(screen.getByText("mahesh@example.com")).toBeInTheDocument();
    expect(screen.queryByText(RAW_ID)).toBeNull();
  });

  it("renders a sublabel-less match by label alone, never a placeholder for the missing sublabel", () => {
    renderView({
      metrics: MATCHED_METRICS,
      userDirectory: new Map([[RAW_ID, { ...MATCHED_ENTITY, sublabel: undefined }]]),
    });
    expect(screen.getByText("mahesh")).toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  // The important case: no entity for this id was in the fetched page. This
  // could mean the user is outside the window fetched, NOT that the user
  // does not exist — so the raw id renders, never an invented "Unknown user".
  it("renders the raw id when no match is found, never a placeholder", () => {
    renderView({ metrics: MATCHED_METRICS, userDirectory: EMPTY_DIRECTORY });
    expect(screen.getByText(RAW_ID)).toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  // kora's `/kora/users` search matches `display_name`/`email`/`handle`,
  // never `id` (`SearchEntities`, kora's `platformadmin/entities.go`) — so a
  // matched row searches by the joined LABEL, which is one of those fields
  // and actually finds the person.
  it("links a matched user's row to a /kora/users search by their name", () => {
    renderView({
      metrics: MATCHED_METRICS,
      userDirectory: new Map([[RAW_ID, MATCHED_ENTITY]]),
    });
    const link = screen.getByRole("link", { name: /mahesh/i });
    expect(link).toHaveAttribute("href", "/kora/users?q=mahesh");
  });

  // The important case, and the one the finding was about: `?q=<uuid>` would
  // be a search kora structurally cannot match (it never searches `id`), so
  // an unmatched row links to the PLAIN, unfiltered directory instead of a
  // query guaranteed to return nothing.
  it("links an unmatched user's row to the plain directory, never a dead id search", () => {
    renderView({ metrics: MATCHED_METRICS, userDirectory: EMPTY_DIRECTORY });
    const link = screen.getByRole("link", { name: RAW_ID });
    expect(link).toHaveAttribute("href", "/kora/users");
  });
});

describe("AiMetricsView — user filters", () => {
  const NAMED_METRICS: KoraAiMetrics = {
    ...METRICS,
    users: [
      {
        userId: "u1",
        attempts: 4,
        resolves: 3,
        corrections: 1,
        budgetRefusals: 0,
        aiCalls: 4,
      },
      {
        userId: "u2",
        attempts: 1,
        resolves: 1,
        corrections: 0,
        budgetRefusals: 1,
        aiCalls: 0,
      },
    ],
  };
  const DIRECTORY: ReadonlyMap<string, EntityRecord> = new Map([
    ["u1", { id: "u1", source: "kora", type: "users", label: "priya", sublabel: "priya@example.com" }],
    ["u2", { id: "u2", source: "kora", type: "users", label: "arjun", sublabel: "arjun@example.com" }],
  ]);

  // The page-scoped limitation must be stated in the UI, not only a comment —
  // kora's ai-metrics endpoint accepts no search param at all.
  it("states in the UI that filters only search this page's users", () => {
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });
    expect(screen.getByText(/only.*this page/i)).toBeInTheDocument();
  });

  // Typing commits to the URL via `router.replace` — asserted as a spy call,
  // the same way `filter-bar.url-filters.test.tsx` asserts `set`/`clear`.
  // Next.js itself is what turns that call into a re-render with new
  // `searchParams`; jsdom has no router to do that, so the FILTERED RESULT is
  // asserted separately below by pre-setting the URL and rendering fresh.
  it("commits typed search text to the URL", async () => {
    const user = userEvent.setup();
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    const search = screen.getByRole("searchbox", { name: /search/i });
    await user.type(search, "priya");
    await user.tab();

    expect(pushedQuery().get("q")).toBe("priya");
  });

  it("narrows the table by the joined name, once the URL says so", () => {
    setSearchParams(new URLSearchParams("q=priya"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    expect(screen.getByText("priya")).toBeInTheDocument();
    expect(screen.queryByText("arjun")).toBeNull();
  });

  it("narrows the table by the raw id, so a pasted UUID still finds its row", () => {
    setSearchParams(new URLSearchParams("q=u2"));
    renderView({ metrics: NAMED_METRICS, userDirectory: EMPTY_DIRECTORY });

    expect(screen.getByText("u2")).toBeInTheDocument();
    expect(screen.queryByText("u1")).toBeNull();
  });

  it("has activity toggles for corrections, budget refusals and AI calls, but not a needs-human toggle", () => {
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });
    expect(screen.getByRole("combobox", { name: /corrections/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /budget refusals/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /ai calls/i })).toBeInTheDocument();
    // "needs human" is an aggregate on `outcomes`, not a per-user field — the
    // plan is explicit that inventing this toggle is out of bounds.
    expect(screen.queryByRole("combobox", { name: /needs human/i })).toBeNull();
  });

  it("filters to users with corrections, once the URL says so", () => {
    setSearchParams(new URLSearchParams("hasCorrections=yes"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    expect(screen.getByText("priya")).toBeInTheDocument();
    expect(screen.queryByText("arjun")).toBeNull();
  });

  // Filters live in the URL: applied here via a pre-set URL rather than a
  // simulated interaction, mirroring `mergeFiltersIntoQuery`'s own contract.
  it("reads an active filter back out of the URL", () => {
    setSearchParams(new URLSearchParams("hasBudgetRefusals=yes"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    expect(screen.getByText("arjun")).toBeInTheDocument();
    expect(screen.queryByText("priya")).toBeNull();
  });

  // The load-bearing property: a filtered list must never sit beside a total
  // that still counts every page. Unfiltered, the pager's real total shows.
  it("shows the true cross-page total when no filter is active", () => {
    renderView({
      metrics: NAMED_METRICS,
      userDirectory: DIRECTORY,
      pagination: { page: 1, limit: 2, total: 500 },
    });
    expect(screen.getByText(/of 500/)).toBeInTheDocument();
  });

  // Filtered, the cross-page total must be gone — only a page-scoped count
  // may appear, never "1 of 500" for a filter that only ever saw 2 rows.
  it("replaces the cross-page total with a page-scoped count once filtered", () => {
    setSearchParams(new URLSearchParams("q=priya"));
    renderView({
      metrics: NAMED_METRICS,
      userDirectory: DIRECTORY,
      pagination: { page: 1, limit: 2, total: 500 },
    });

    expect(screen.queryByText(/of 500/)).toBeNull();
    expect(screen.getByText(/1 of 2 on this page/i)).toBeInTheDocument();
  });

  // The scope note's "use the pager" clause must not appear while filtered —
  // it names a total that the filtered branch deliberately does not show,
  // and it must never be read as "paging is unavailable here" (it is not;
  // see the next test).
  it("mentions the pager in the unfiltered scope note", () => {
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });
    expect(screen.getByText(/use the pager/i)).toBeInTheDocument();
  });

  it("drops the 'use the pager' clause once filtered", () => {
    setSearchParams(new URLSearchParams("q=priya"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });
    expect(screen.queryByText(/use the pager/i)).toBeNull();
  });

  // The load-bearing fix: a filtered operator can still page. Only the
  // cross-page TOTAL is withheld while filtered (asserted above) — the
  // next/prev links themselves keep working, because `pageHref` carries the
  // filter query to the next page.
  it("keeps working next/prev links while filtered, with no total beside them", () => {
    setSearchParams(new URLSearchParams("q=priya"));
    renderView({
      metrics: NAMED_METRICS,
      userDirectory: DIRECTORY,
      pager: {
        precedingCount: 2,
        nextHref: "/kora/ai-metrics?page=2&q=priya",
        previousHref: "/kora/ai-metrics?q=priya",
      },
      pagination: { page: 2, limit: 2, total: 500 },
    });

    expect(screen.getByRole("link", { name: /next page of users/i })).toHaveAttribute(
      "href",
      "/kora/ai-metrics?page=2&q=priya",
    );
    expect(screen.getByRole("link", { name: /previous page of users/i })).toHaveAttribute(
      "href",
      "/kora/ai-metrics?q=priya",
    );
    expect(screen.queryByText(/of 500/)).toBeNull();
  });

  // `resolveState`'s `filtered` flag, not the plain empty-state copy: a
  // filter that matches nothing on this page is a different fact from the
  // page genuinely having no users.
  it("renders 'no matches, clear filters' rather than 'no users in this window' for a filtered-empty page", () => {
    setSearchParams(new URLSearchParams("q=does-not-exist"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    expect(screen.queryByText(/no users in this window/i)).toBeNull();
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  // The clear button commits an empty query, the same way `set` does — the
  // reactive round-trip (clicking actually restores the unfiltered table) is
  // Next.js's job, not this component's; see the file's top-of-file note.
  //
  // Two "Clear filters" buttons are on screen at once here — the filter
  // bar's own (it always offers one while a filter is active) and the
  // filtered-empty state's — so this asserts EVERY one commits the same
  // empty query rather than picking one arbitrarily.
  it("commits an empty query when 'Clear filters' is clicked on a filtered-empty page", async () => {
    const user = userEvent.setup();
    setSearchParams(new URLSearchParams("q=does-not-exist"));
    renderView({ metrics: NAMED_METRICS, userDirectory: DIRECTORY });

    for (const clear of screen.getAllByRole("button", { name: /clear filters/i })) {
      await user.click(clear);
    }

    expect(replace).toHaveBeenCalled();
    for (const call of replace.mock.calls as [string][]) {
      expect(new URLSearchParams(call[0].split("?")[1] ?? "").get("q")).toBeNull();
    }
  });
});

describe("AiMetricsView — non-ready states", () => {
  it("renders the surface state instead of the tables when the read failed", () => {
    renderView({ metrics: null, state: { kind: "error", message: "boom" } });
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText(/attempts/i)).toBeNull();
  });

  // A 501 (Kora not federated) is a legitimate state, not an error — exactly
  // as the overview already treats it.
  it("renders a 501 as not measured rather than an error", () => {
    renderView({ metrics: null, state: { kind: "instrumentation-unavailable" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
