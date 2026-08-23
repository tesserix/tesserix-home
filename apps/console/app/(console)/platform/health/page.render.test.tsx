import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/health", () => ({ readEstateHealth: vi.fn() }));

import { readEstateHealth } from "@/lib/health";
import HealthPage from "./page";

// Nothing about the session is mocked, because the page reads nothing about
// it. This page has no view gate: middleware has already established the
// operator is internal, and no console page gates VIEWING on a capability —
// `/platform/ai-usage` is the sibling this follows. The two tests at the
// bottom of this file are what pin that.

function health(overrides: Partial<Awaited<ReturnType<typeof readEstateHealth>>> = {}) {
  return {
    state: "healthy" as const,
    stale: false,
    checkedAt: "2026-08-23T12:00:00Z",
    reason: null,
    workloads: { total: 8, ready: 8 },
    databases: { total: 1, ready: 1 },
    ...overrides,
  };
}

afterEach(() => vi.resetAllMocks());

describe("the health page", () => {
  it("renders the healthy state", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(health({ state: "healthy" }));

    render(await HealthPage());

    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders the degraded state", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "degraded", reason: "mp-orders 0/2 ready" }),
    );

    render(await HealthPage());

    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  it("renders the unmeasured state", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "unmeasured", workloads: { total: 0, ready: 0 }, databases: { total: 0, ready: 0 } }),
    );

    render(await HealthPage());

    expect(screen.getByText("Unmeasured")).toBeInTheDocument();
  });

  it("renders the degraded reason as text, not only in an attribute", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "degraded", reason: "mp-orders 0/2 ready" }),
    );

    render(await HealthPage());

    // Not `getByTitle` — the whole point is that this text is VISIBLE AS
    // TEXT. It was already reachable without a mouse: the indicator's
    // `aria-label` carries it via `describeHealth`, pinned in
    // health-indicator.render.test.tsx. What it was not, was readable by
    // anyone who does not hover or use a screen reader. `getAllByText`
    // rather than `getByText`: the reason legitimately appears twice (the
    // state section's accessible sentence, and the measured section's own
    // line), and both are real text, not an attribute.
    expect(screen.getAllByText(/mp-orders 0\/2 ready/).length).toBeGreaterThan(0);
  });

  it("breaks a multi-problem reason onto separate lines", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({
        state: "degraded",
        reason: "mp-orders 0/2 ready; products_db unreachable",
      }),
    );

    render(await HealthPage());

    const first = screen.getByText("mp-orders 0/2 ready");
    const second = screen.getByText("products_db unreachable");

    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    // Two distinct text nodes, not one string containing both — that is what
    // "separate lines" means for a DOM assertion.
    expect(first).not.toBe(second);
  });

  it("names all three not-yet-measured concerns", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.getByText(/Uptime/)).toBeInTheDocument();
    expect(screen.getByText(/Observability/)).toBeInTheDocument();
    expect(screen.getByText(/Custom domains/)).toBeInTheDocument();
  });

  it("never badges the not-yet-measured concerns as SOON", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    // Badging them SOON would just relocate the placeholder this page exists
    // to replace with an honest "nothing measures this yet".
    expect(screen.queryByText(/SOON/)).not.toBeInTheDocument();
  });

  it("does not list Databases or Service health as unmeasured", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    // Exact-text "Databases", so it cannot collide with anything the measured
    // section renders. The tile label reads "Databases ready" when there is a
    // reading and bare "Databases" only while PARKED — which this fixture is
    // not — and the row list's own term reads "Databases detail". (The older
    // comment here claimed the tile label was the only thing to worry about;
    // it also had to account for the row list's term, which used to be a
    // visible bare "Databases" heading duplicating the tile above it. That
    // heading is now `sr-only` and reworded — see the sibling test below.)
    expect(screen.queryByText("Databases")).not.toBeInTheDocument();
    expect(screen.queryByText("Service health")).not.toBeInTheDocument();
  });

  it("renders for an operator holding only the console-entry ticket", async () => {
    // No session is mocked at all, which IS the assertion: the page reads
    // nothing about who the operator is. An operator holding only `read`
    // reaches this page through middleware like any other, and a page-level
    // capability gate — the console's first — would refuse them.
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.queryByText(/do not have permission/i)).not.toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders for an operator with no roles at all", async () => {
    // Under `AUTH_PROVIDER=google` sessions carry NO roles, so any
    // `hasCapability(...)` gate here is false for everyone and this page would
    // 403 the whole estate while `/platform/ai-usage` rendered normally. There
    // is no gate, so this renders.
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.queryByText(/do not have permission/i)).not.toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  describe("the state sentence", () => {
    // `describeHealth`'s healthy clause is nothing but "N of M workloads and
    // N of M databases ready" — a prose restatement of the two numbers the
    // tiles directly below already carry. The page suppresses it for a
    // healthy, non-stale reading and prints it for every other case. That is
    // a CONTENT decision, so it gets pinned in both directions: nothing else
    // in this file would catch either its disappearance from a degraded
    // reading or its accidental return to a healthy one.

    it("prints no restating sentence for a healthy, non-stale reading", async () => {
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({ state: "healthy", stale: false }),
      );

      render(await HealthPage());

      expect(screen.getByText("Healthy")).toBeInTheDocument();
      expect(screen.queryByText(/Estate healthy:/)).not.toBeInTheDocument();
      // The numbers themselves are still on the page — the tiles carry them.
      expect(screen.getByText("8 / 8")).toBeInTheDocument();
      expect(screen.getByText("1 / 1")).toBeInTheDocument();
    });

    it("prints the sentence for a degraded reading", async () => {
      // Degraded's clause is the REASON, which the tiles have no equivalent
      // for. Suppressing it would delete the only prose account of what went
      // wrong from the state section.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({ state: "degraded", reason: "mp-orders 0/2 ready" }),
      );

      render(await HealthPage());

      expect(screen.getByText(/Estate degraded: mp-orders 0\/2 ready\./)).toBeInTheDocument();
    });

    it("prints the sentence for an unmeasured reading", async () => {
      // "Estate health is not being measured" is a claim about the
      // INSTRUMENT, not about counts, and it is not restated anywhere else.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          state: "unmeasured",
          checkedAt: null,
          workloads: { total: 0, ready: 0 },
          databases: { total: 0, ready: 0 },
        }),
      );

      render(await HealthPage());

      expect(screen.getByText(/Estate health is not being measured/)).toBeInTheDocument();
    });

    it("prints the sentence for a stale healthy reading", async () => {
      // `stale` earns its own clause: it names a fact the timestamp line
      // cannot, that the CURRENT reading could not be taken at all.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({ state: "healthy", stale: true }),
      );

      render(await HealthPage());

      expect(screen.getByText("Healthy")).toBeInTheDocument();
      expect(
        screen.getByText(/This is the last known reading, taken at 2026-08-23T12:00:00Z/),
      ).toBeInTheDocument();
    });
  });

  it("prints no 0 / 0 count when nothing was measured", async () => {
    // The failure this guards: `readEstateHealth()` falls back to `unmeasured`
    // with zero counts on an unobtainable token, an unreachable API, a 403,
    // the 3s abort, or an unset origin — and printing "Workloads 0 / 0" then
    // asserts that workloads ARE measured at the exact moment nothing measured
    // either section, while reading as "there are zero workloads".
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({
        state: "unmeasured",
        checkedAt: null,
        workloads: { total: 0, ready: 0 },
        databases: { total: 0, ready: 0 },
      }),
    );

    render(await HealthPage());

    expect(screen.queryByText("0 / 0")).not.toBeInTheDocument();
    expect(screen.queryByText(/Workloads ready/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Databases ready/)).not.toBeInTheDocument();
    // "Not measured" is `StatTile`'s own `instrumentation-unavailable`
    // copy (see `components/kit/stat-tile.tsx`) — the page now uses that
    // shared vocabulary instead of a bespoke "Nothing measured this" string,
    // so both parked tiles (Workloads, Databases) render it once each.
    expect(screen.getAllByText("Not measured")).toHaveLength(2);
  });

  it("says a section was not measured when its total is zero", async () => {
    // A measured reading can still count nothing in ONE section — a partial
    // payload, a source that did not answer. That section gets the same
    // honesty as a wholly unmeasured reading, not "0 / 0".
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({
        state: "degraded",
        reason: "database probe did not answer",
        workloads: { total: 8, ready: 7 },
        databases: { total: 0, ready: 0 },
      }),
    );

    render(await HealthPage());

    expect(screen.getByText("7 / 8")).toBeInTheDocument();
    expect(screen.queryByText("0 / 0")).not.toBeInTheDocument();
    // See the "prints no 0 / 0" test above for why this is "Not measured".
    expect(screen.getAllByText("Not measured")).toHaveLength(1);
  });

  it("dates the reading with a deterministic UTC-formatted timestamp", async () => {
    // The header holds its own reading across soft navigations, so the two
    // surfaces can disagree; the timestamp is what makes them comparable.
    // This page is a SERVER component that never hydrates, so there is no
    // hydration mismatch to guard against — but the format must still be
    // deterministic (fixed locale, explicit UTC), never the viewer's own
    // locale/timezone and never a relative age. The raw ISO value is pinned
    // to the `<time>` element's `dateTime` attribute.
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ checkedAt: "2026-08-23T12:00:00Z" }),
    );

    const { container } = render(await HealthPage());

    expect(screen.getByText("Last measured")).toBeInTheDocument();
    expect(screen.getByText("23 Aug 2026, 12:00 UTC")).toBeInTheDocument();
    const time = container.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-08-23T12:00:00Z");
  });

  it("renders a malformed timestamp as its raw string rather than throwing", async () => {
    // `checked_at` is untrusted: `lib/health.ts` type-checks it and never
    // parses it, so a version skew, a Go zero time serialised as
    // "0001-01-01 00:00:00", or a truncated value arrives here as a
    // well-typed string that `new Date()` cannot read.
    // `Intl.DateTimeFormat.format` THROWS `RangeError: Invalid time value`
    // on one, inside an async server component — the whole page would render
    // its error boundary at exactly the moment an operator went looking for
    // estate health. Before the formatter existed the same string printed
    // harmlessly.
    vi.mocked(readEstateHealth).mockResolvedValue(health({ checkedAt: "not-a-date" }));

    const { container } = render(await HealthPage());

    // The page renders at all — the state, the counts, everything.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("8 / 8")).toBeInTheDocument();
    // And the unparseable value is shown as-is rather than swallowed.
    expect(screen.getByText("not-a-date")).toBeInTheDocument();
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("not-a-date");
  });

  it("renders an out-of-range ISO-shaped timestamp as its raw string rather than throwing", async () => {
    // The shape that gets past a naive eyeball review and past
    // `lib/health.ts`'s `typeof === "string"` check: it LOOKS like RFC 3339,
    // so nothing upstream objects, and `new Date()` still returns an Invalid
    // Date that `Intl.DateTimeFormat.format` throws on.
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ checkedAt: "2026-13-45T99:99:99Z" }),
    );

    render(await HealthPage());

    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("2026-13-45T99:99:99Z")).toBeInTheDocument();
  });

  it("says so rather than blanking when there is an empty timestamp", async () => {
    // `health.checkedAt ?` is falsy for `""`, so this takes the same branch
    // as `null` and never reaches the formatter. Costs nothing to pin.
    vi.mocked(readEstateHealth).mockResolvedValue(health({ checkedAt: "" }));

    render(await HealthPage());

    expect(screen.getByText(/Last measured: unknown/)).toBeInTheDocument();
  });

  it("says so rather than blanking when there is no timestamp", async () => {
    vi.mocked(readEstateHealth).mockResolvedValue(health({ checkedAt: null }));

    render(await HealthPage());

    expect(screen.getByText(/Last measured: unknown/)).toBeInTheDocument();
  });

  describe("per-item detail", () => {
    it("renders a row per workload with its name and ready/desired count", async () => {
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 8,
            ready: 8,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
        }),
      );

      render(await HealthPage());

      expect(screen.getByText("console")).toBeInTheDocument();
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });

    it("keeps a long workload name reachable via `title` when the row truncates its display text", async () => {
      // The row list used to have no fallback at all for a name too long to
      // fit — the cramped `sm:max-w-md` column made "tesserix-postgres" wrap
      // mid-word. The fix truncates the display text instead, but a
      // truncated name must still be reachable in full, which is what
      // `title` (and the raw text still present in the DOM) is for.
      const longName = "mp-connector-external-marketplace-integrations-worker";
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 1,
            ready: 1,
            items: [{ name: longName, desired: 1, ready: 1, ok: true }],
          },
        }),
      );

      render(await HealthPage());

      const name = screen.getByText(longName);
      expect(name).toHaveAttribute("title", longName);
    });

    it("renders a row per database with its name, ready/instances count, and phase", async () => {
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          databases: {
            total: 1,
            ready: 1,
            items: [
              {
                name: "tesserix-postgres",
                instances: 1,
                ready: 1,
                phase: "Cluster in healthy state",
                ok: true,
              },
            ],
          },
        }),
      );

      render(await HealthPage());

      expect(screen.getByText("tesserix-postgres")).toBeInTheDocument();
      // Two, not one: the section summary count ("Databases ready") and the
      // row both legitimately read "1 / 1" here (1 database, 1 instance).
      expect(screen.getAllByText("1 / 1")).toHaveLength(2);
      expect(screen.getByText(/Cluster in healthy state/)).toBeInTheDocument();
    });

    it("marks a row short of target using the page's own degraded vocabulary", async () => {
      // Same shape/colour the state indicator uses for "degraded" — no fourth
      // colour invented for this. `mp-orders` is short (1 of 2 ready); a
      // second, on-target row proves the marker is per-row, not per-section.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          state: "degraded",
          reason: "mp-orders 1/2 ready",
          workloads: {
            total: 8,
            ready: 7,
            items: [
              { name: "mp-orders", desired: 2, ready: 1, ok: false },
              { name: "console", desired: 2, ready: 2, ok: true },
            ],
          },
        }),
      );

      const { container } = render(await HealthPage());

      expect(screen.getByText("1 / 2")).toBeInTheDocument();
      expect(screen.getByText("2 / 2")).toBeInTheDocument();

      // The degraded marker (diamond, `bg-warning`) sits on the short row and
      // nowhere else in the row list — same shape/colour class the state
      // section uses for "Degraded", never a fourth colour invented for the
      // row list. Scoped to `li` so the state section's own "Degraded" dot
      // (this fixture's overall state) does not get counted here too.
      const degradedDots = container.querySelectorAll("li .rotate-45.bg-warning");
      expect(degradedDots.length).toBe(1);
    });

    it("marks a database whose counts match but whose phase failed it", async () => {
      // THE case this branch's phase check exists for, and the one a row
      // deriving its own verdict from counts gets wrong: CNPG reports 1 of 1
      // instance ready while the cluster is mid-failover, so the row reads
      // "1 / 1" directly under a summary reading "0 / 1". Two different
      // numbers for the same database under the word "ready", on one screen.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          state: "degraded",
          reason: 'tesserix-postgres reports phase "Failing over"',
          databases: {
            total: 1,
            ready: 0,
            items: [
              {
                name: "tesserix-postgres",
                instances: 1,
                ready: 1,
                phase: "Failing over",
                ok: false,
              },
            ],
          },
        }),
      );

      const { container } = render(await HealthPage());

      const rows = container.querySelectorAll("li .rotate-45.bg-warning");
      expect(rows.length).toBe(1);
      // And the phase does not render in the muted class a healthy phase
      // gets — an operator scanning the list must find the bad row without
      // reading and interpreting every phase string.
      const phase = screen.getByText("Failing over");
      expect(phase.className).not.toContain("text-muted-foreground");
    });

    it("marks a database reporting zero instances", async () => {
      // Go degrades on this (`Instances > 0`, a rule counts alone cannot
      // express); unmarked it renders "0 / 0" and reads as "wants nothing,
      // has nothing, fine".
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          state: "degraded",
          reason: "tesserix-postgres 0/0 instances ready",
          databases: {
            total: 1,
            ready: 0,
            items: [
              { name: "tesserix-postgres", instances: 0, ready: 0, phase: null, ok: false },
            ],
          },
        }),
      );

      const { container } = render(await HealthPage());

      expect(container.querySelectorAll("li .rotate-45.bg-warning").length).toBe(1);
      // A textual carrier too, not the colour alone. "short of target" would
      // be wrong here — nothing is short, the cluster reports no instances.
      expect(screen.getByText("— not ready")).toBeInTheDocument();
    });

    it("says so when the row list is shorter than the count above it", async () => {
      // `total` comes off the payload, the rows come from the item parser,
      // and nothing reconciles them: one malformed entry among eight renders
      // "8 / 8" above a single row, which an operator reads as the estate
      // inventory.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 8,
            ready: 8,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
        }),
      );

      render(await HealthPage());

      expect(screen.getByText("showing 1 of 8")).toBeInTheDocument();
    });

    it("says nothing about the row count when the list is complete", async () => {
      // Guards the guard: a note that always renders is noise, and would
      // train an operator to ignore the one case it is meant to flag.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 1,
            ready: 1,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
        }),
      );

      render(await HealthPage());

      expect(screen.queryByText(/showing \d+ of \d+/)).not.toBeInTheDocument();
    });

    it("keeps the row list inside the dd it belongs to", async () => {
      // The HTML content model for a `dl > div` is one-or-more `dt` followed
      // by one-or-more `dd`; a `ul` sibling is not permitted, and a screen
      // reader walking the list orphans the rows from their term.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 1,
            ready: 1,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
        }),
      );

      const { container } = render(await HealthPage());

      const list = container.querySelector("dl ul");
      expect(list).not.toBeNull();
      expect(list?.closest("dd")).not.toBeNull();
      expect(container.querySelector("dl > div > ul")).toBeNull();
    });

    it("does not repeat the tile's own label as a heading above its rows", async () => {
      // With the rows sitting directly under their own tile, a visible term
      // restating that tile is pure duplication: "Workloads ready" as the
      // tile label and "Workloads" as a heading an inch below it. The term
      // still exists — a `dd` needs one, and a screen reader needs something
      // to associate the rows with — but it is `sr-only` and worded as what
      // the rows ARE rather than as a second copy of the tile's label.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 1,
            ready: 1,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
        }),
      );

      const { container } = render(await HealthPage());

      expect(screen.getByText("Workloads ready")).toBeInTheDocument();
      // No bare "Workloads" heading anywhere — exact text, so it cannot match
      // the tile's own "Workloads ready".
      expect(screen.queryByText("Workloads")).not.toBeInTheDocument();
      const term = container.querySelector("dl dt");
      expect(term?.textContent).toBe("Workloads detail");
      expect(term?.className).toContain("sr-only");
    });

    it("keeps each row list in the same column as the tile it summarises", async () => {
      // The composition this page settled on: two columns, Workloads and
      // Databases, each a tile with its own rows beneath it. A tile row above
      // a stack of full-width lists puts a count a screen away from the name
      // it belongs to; this is the DOM fact that stops that coming back.
      vi.mocked(readEstateHealth).mockResolvedValue(
        health({
          workloads: {
            total: 1,
            ready: 1,
            items: [{ name: "console", desired: 2, ready: 2, ok: true }],
          },
          databases: {
            total: 1,
            ready: 1,
            items: [
              {
                name: "tesserix-postgres",
                instances: 1,
                ready: 1,
                phase: "Cluster in healthy state",
                ok: true,
              },
            ],
          },
        }),
      );

      render(await HealthPage());

      const workloadColumn = screen.getByText("Workloads detail").closest("dl")?.parentElement;
      expect(workloadColumn?.textContent).toContain("Workloads ready");
      expect(workloadColumn?.textContent).toContain("console");
      // And nothing from the other section leaks into it.
      expect(workloadColumn?.textContent).not.toContain("Databases ready");
      expect(workloadColumn?.textContent).not.toContain("tesserix-postgres");

      const databaseColumn = screen.getByText("Databases detail").closest("dl")?.parentElement;
      expect(databaseColumn?.textContent).toContain("Databases ready");
      expect(databaseColumn?.textContent).toContain("tesserix-postgres");
      expect(databaseColumn?.textContent).not.toContain("Workloads ready");
    });

    it("renders the page unchanged when items is absent — no empty table, no throw", async () => {
      // The older platform-api answers without `items` at all, and one is
      // running in production until this ships. The page must render exactly
      // as it does today: the summary counts, and nothing claiming to be a
      // row list underneath them.
      vi.mocked(readEstateHealth).mockResolvedValue(health());

      render(await HealthPage());

      expect(screen.getByText("Healthy")).toBeInTheDocument();
      expect(screen.getByText("8 / 8")).toBeInTheDocument();
      // No table/list role born from a null items array, and no row content
      // from the ablation fixtures leaking in from elsewhere.
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByText("console")).not.toBeInTheDocument();
      expect(screen.queryByText("mp-orders")).not.toBeInTheDocument();
    });
  });
});
