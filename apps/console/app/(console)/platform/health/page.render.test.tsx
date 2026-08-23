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

    // "Databases" is a substring of nothing else on the not-yet-measured
    // list, so this is safe against the workload/database count labels,
    // which read "Databases ready" rather than bare "Databases".
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
    expect(screen.getAllByText(/Nothing measured this\./)).toHaveLength(2);
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
    expect(screen.getAllByText(/Nothing measured this\./)).toHaveLength(1);
  });

  it("dates the reading with the raw ISO timestamp", async () => {
    // The header holds its own reading across soft navigations, so the two
    // surfaces can disagree; the timestamp is what makes them comparable.
    // RAW ISO — a relative age or a locale format would be a hydration
    // mismatch between the server render and the client hydrate.
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ checkedAt: "2026-08-23T12:00:00Z" }),
    );

    render(await HealthPage());

    expect(screen.getByText("Last measured 2026-08-23T12:00:00Z")).toBeInTheDocument();
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
