import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "@/components/kit/surface-state";
import { PlatformApiError } from "@/lib/platform-api";
import type { AuditEntry, AuditSourceFailure, SourcedAuditEntry } from "@/lib/audit";
import { mergeTimeline, withSource } from "@/lib/audit";
import { migrationsPendingMessage, readFailedMessage } from "@/lib/db-read-error";
import {
  ALL_PRODUCTS_LABEL,
  CONSOLE_LOG_SURFACE,
  consoleReadError,
  AUDIT_FILTERS,
  TIMELINE_EMPTY_MESSAGE,
  TIMELINE_SCOPE_NOTE,
  buildSourceNotices,
  readAuditSource,
  sourceState,
  timelineState,
  toFilterValues,
} from "./page";
import { AuditTimeline, IncompleteSources, type SourceNotice } from "./audit-timeline";
import { parseMetadataFields } from "./audit-metadata";

// `dbReadError` logs the real error server-side on every call — that is the
// half of it an engineer needs, and it is deliberately noisy in production
// logs, not in a test run.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const CONSOLE_READ_FAILED = readFailedMessage(CONSOLE_LOG_SURFACE);

/** Postgres reporting a missing relation, exactly as `pg` raises it: the
 *  SQLSTATE on `.code`, the relation name in `.message`. */
function undefinedTable(relation: string): Error & { code: string } {
  return Object.assign(new Error(`relation "${relation}" does not exist`), {
    code: "42P01",
  });
}

// `useUrlFilters` reads the router. The timeline is rendered here, not the
// page, because a server component cannot be rendered by Testing Library —
// the page's own logic is exercised through its exported pure functions.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/platform/audit-log",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * A product row as it arrives from the aggregate endpoint: already attributed
 * and already namespaced, because apps/web's normaliser did both at the only
 * boundary where the product is known for certain.
 */
const PRODUCT_ROW: SourcedAuditEntry = {
  id: "mark8ly:9f2",
  source: "mark8ly",
  actor: "ops@mark8ly.com",
  action: "tenant.suspend",
  target: "tenant:acme",
  timestamp: "2026-08-16T09:03:00.000Z",
};

/** A homechef row, so attribution can be asserted across DIFFERENT sources. */
const FE3DR_ROW: SourcedAuditEntry = {
  id: "homechef:c-1",
  source: "homechef",
  actor: "ada@fe3dr.test",
  action: "chef.payout.release",
  target: "chef:c-1",
  timestamp: "2026-08-16T09:01:00.000Z",
};

/** The console's own row, as `console_audit_log` returns it — no source column. */
const CONSOLE_ROW: AuditEntry = {
  id: "41",
  actor: "sunita@tesserix.app",
  action: "identity.lookup",
  target: "sunita@example.com",
  timestamp: "2026-08-16T09:02:00.000Z",
};

function renderTimeline(over: Partial<Parameters<typeof AuditTimeline>[0]> = {}) {
  return render(
    <AuditTimeline
      descriptors={AUDIT_FILTERS}
      values={{}}
      entries={[]}
      state={{ kind: "ready" }}
      emptyMessage={TIMELINE_EMPTY_MESSAGE}
      notices={[]}
      failures={[]}
      scopeNote={TIMELINE_SCOPE_NOTE}
      {...over}
    />,
  );
}

describe("readAuditSource", () => {
  it("reads a source the surface offers", () => {
    expect(readAuditSource({ source: "kora" })).toBe("kora");
    expect(readAuditSource({ source: "console" })).toBe("console");
  });

  it("treats an unset filter as every source", () => {
    expect(readAuditSource({})).toBeNull();
    expect(readAuditSource({ source: "" })).toBeNull();
  });

  it("drops a source that does not exist rather than forwarding it", () => {
    // Forwarding it upstream returns nothing and renders `filtered-empty`,
    // which says "nothing matches" when the truth is "that source does not
    // exist". DevAI is a real estate product with no audit source at all.
    expect(readAuditSource({ source: "devai" })).toBeNull();
    expect(readAuditSource({ source: "../../etc/passwd" })).toBeNull();
  });

  it("ignores a repeated param", () => {
    expect(readAuditSource({ source: ["kora", "console"] })).toBeNull();
  });

  it("round-trips the applied filter back to the bar", () => {
    expect(toFilterValues("kora")).toEqual({ source: "kora" });
    expect(toFilterValues(null)).toEqual({});
  });

  it("offers the console as a source rather than as a mode", () => {
    const options = AUDIT_FILTERS[0].options ?? [];
    expect(options.map((option) => option.value)).toEqual([
      "mark8ly",
      "kora",
      "homechef",
      "console",
    ]);
  });
});

describe("timelineState", () => {
  const rows = [PRODUCT_ROW];

  it("reports empty — not ready — when every source answered with nothing", () => {
    expect(
      timelineState({ upstreamError: null, consoleError: null, rows: [], filtered: false }),
    ).toEqual({ kind: "empty" });
  });

  it("reports filtered-empty when a source filter is narrowing", () => {
    expect(
      timelineState({ upstreamError: null, consoleError: null, rows: [], filtered: true }),
    ).toEqual({ kind: "filtered-empty" });
  });

  it("maps a 501 to instrumentation-unavailable, not to error", () => {
    expect(
      timelineState({
        upstreamError: new PlatformApiError("parked", 501),
        consoleError: null,
        rows: [],
        filtered: false,
      }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });

  it("maps a real failure to error, not to instrumentation-unavailable", () => {
    // Guards the guard above: a blanket mapping would pass that test too.
    expect(
      timelineState({
        upstreamError: new PlatformApiError("boom", 502),
        consoleError: null,
        rows: [],
        filtered: false,
      }),
    ).toEqual({ kind: "error", message: "boom" });
  });

  it("lets a genuine outage win over a parked source", () => {
    // "Not instrumented" is the gentler claim. Making it while something is
    // actually broken understates an outage in the one place understatement
    // is expensive.
    expect(
      timelineState({
        upstreamError: new PlatformApiError("parked", 501),
        consoleError: consoleReadError(new PlatformApiError("connection refused", undefined)),
        rows: [],
        filtered: false,
      }),
      // Not "connection refused": the console's log is read off `pg`, and its
      // rejection message is written for a server log, not for this page.
    ).toEqual({ kind: "error", message: CONSOLE_READ_FAILED });
  });

  it("reads an un-migrated table as instrumentation-unavailable, not as an error", () => {
    // The screenshot this fix came from: the tables do not exist because the
    // migrations have not been run. That is not "something went wrong" — it is
    // the calm "not wired up yet" state, and its copy names the remedy.
    expect(
      timelineState({
        upstreamError: null,
        consoleError: consoleReadError(undefinedTable("console_audit_log")),
        rows: [],
        filtered: false,
      }),
    ).toEqual({
      kind: "instrumentation-unavailable",
      title: "Not set up yet",
      message: migrationsPendingMessage(CONSOLE_LOG_SURFACE),
    });
  });

  it("still reads a different Postgres failure as an error", () => {
    // Guards the guard above: mapping every `pg` rejection to
    // instrumentation-unavailable would pass that test and quietly describe a
    // dead database as an un-migrated one.
    const denied = Object.assign(new Error("permission denied for table console_audit_log"), {
      code: "42501",
    });
    expect(
      timelineState({
        upstreamError: null,
        consoleError: consoleReadError(denied),
        rows: [],
        filtered: false,
      }),
    ).toEqual({ kind: "error", message: CONSOLE_READ_FAILED });
  });

  it("never carries the driver's own message into the state", () => {
    for (const caught of [undefinedTable("console_audit_log"), new Error("ECONNREFUSED 10.0.0.4:5432")]) {
      const state = timelineState({
        upstreamError: null,
        consoleError: consoleReadError(caught),
        rows: [],
        filtered: false,
      });
      const rendered = "message" in state ? (state.message ?? "") : "";
      expect(rendered).not.toContain("relation");
      expect(rendered).not.toContain("ECONNREFUSED");
    }
  });

  it("stays ready when one source failed and the other returned rows", () => {
    // THE rule of this surface: the console's own log is served by a database
    // the products' upstreams cannot touch, so a parked kora-api must not
    // blank out rows that were read successfully.
    expect(
      timelineState({
        upstreamError: new PlatformApiError("parked", 501),
        consoleError: null,
        rows,
        filtered: false,
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("buildSourceNotices", () => {
  it("reports a parked upstream as instrumentation-unavailable", () => {
    const notices = buildSourceNotices({
      upstreamError: new PlatformApiError("parked", 501),
      consoleError: null,
      upstreamProduct: "all",
      consoleQueried: true,
    });
    expect(notices).toEqual([
      {
        source: "all",
        label: ALL_PRODUCTS_LABEL,
        state: { kind: "instrumentation-unavailable" },
      },
    ]);
  });

  it("names a single product rather than the aggregate", () => {
    const notices = buildSourceNotices({
      upstreamError: new PlatformApiError("boom", 502),
      consoleError: null,
      upstreamProduct: "homechef",
      consoleQueried: false,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].label).toBe("Fe3dr");
    expect(notices[0].state).toEqual({ kind: "error", message: "boom" });
  });

  it("says nothing about a source that answered", () => {
    // Guards the guard: a notice list that is always populated would satisfy
    // every assertion above while warning about healthy sources.
    expect(
      buildSourceNotices({
        upstreamError: null,
        consoleError: null,
        upstreamProduct: "all",
        consoleQueried: true,
      }),
    ).toEqual([]);
  });

  it("says nothing about a source the filter excluded", () => {
    // Filtering to the console's own log must not warn about Kora. It is data
    // the operator did not ask for.
    expect(
      buildSourceNotices({
        upstreamError: new PlatformApiError("parked", 501),
        consoleError: null,
        upstreamProduct: null,
        consoleQueried: true,
      }),
    ).toEqual([]);
  });

  it("reports the console's own log independently of the products", () => {
    const notices = buildSourceNotices({
      upstreamError: null,
      consoleError: consoleReadError(new PlatformApiError("not configured", 501)),
      upstreamProduct: "all",
      consoleQueried: true,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].label).toBe("Console");
  });

  it("treats an unread source as unreportable, not as empty", () => {
    expect(sourceState(null)).toEqual({ kind: "empty" });
  });
});

describe("the merged timeline renders", () => {
  it("shows entries from both sources, newest first", () => {
    const entries = mergeTimeline(
      [PRODUCT_ROW],
      withSource([CONSOLE_ROW], "console"),
    );
    renderTimeline({ entries, state: { kind: "ready" } });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("ops@mark8ly.com");
    expect(rows[0]).toHaveTextContent("tenant.suspend");
    expect(rows[1]).toHaveTextContent("sunita@tesserix.app");
    expect(rows[1]).toHaveTextContent("identity.lookup");
  });

  it("renders the migration remedy, not the driver's message, for a missing table", () => {
    // The whole bug in one assertion: `relation "console_audit_log" does not
    // exist` was rendered verbatim to an operator, followed by advice to try
    // again shortly — which could never work.
    renderTimeline({
      state: timelineState({
        upstreamError: null,
        consoleError: consoleReadError(undefinedTable("console_audit_log")),
        rows: [],
        filtered: false,
      }),
    });

    expect(screen.getByText("Not set up yet")).toBeInTheDocument();
    expect(
      screen.getByText(migrationsPendingMessage(CONSOLE_LOG_SURFACE)),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("relation");
    expect(document.body.textContent).not.toContain("Try again shortly");
  });

  it("keeps the console's rows when the upstream is parked", () => {
    // The requirement in one test: a 501 from the products' aggregate renders
    // instrumentation-unavailable, and the console's own rows still render.
    // The local source must not be taken down by the remote one.
    const entries = withSource([CONSOLE_ROW], "console");
    const notices: SourceNotice[] = [
      {
        source: "all",
        label: ALL_PRODUCTS_LABEL,
        state: { kind: "instrumentation-unavailable" },
      },
    ];
    renderTimeline({
      entries,
      state: timelineState({
        upstreamError: new PlatformApiError("parked", 501),
        consoleError: null,
        rows: entries,
        filtered: false,
      }),
      notices,
    });

    expect(screen.getByText("Instrumentation unavailable")).toBeInTheDocument();
    expect(screen.getByText(INSTRUMENTATION_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(ALL_PRODUCTS_LABEL)).toBeInTheDocument();
    expect(screen.getByText("sunita@tesserix.app identity.lookup sunita@example.com")).toBeInTheDocument();
  });

  it("names the source on EVERY row", () => {
    // The column an operator most needs on a merged timeline. "Who did what"
    // without "where" is not a whole answer, and the row's other fields are
    // deliberately product-neutral, so nothing else on screen can supply it.
    const entries = mergeTimeline(
      [PRODUCT_ROW, FE3DR_ROW],
      withSource([CONSOLE_ROW], "console"),
    );
    renderTimeline({ entries, state: { kind: "ready" } });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveTextContent(/Source:/);
    }
    // Newest first: mark8ly 09:03, console 09:02, homechef 09:01.
    expect(rows[0]).toHaveTextContent("Mark8ly");
    expect(rows[1]).toHaveTextContent("Console");
    expect(rows[2]).toHaveTextContent("Fe3dr");
  });

  it("gives each row ITS OWN source, not one label repeated", () => {
    // GUARDS THE GUARD. "every row has a source" passes just as happily when
    // every row is stamped with the same one — which is the worse defect,
    // because a confidently wrong Source column is read as fact.
    const entries = mergeTimeline(
      [PRODUCT_ROW, FE3DR_ROW],
      withSource([CONSOLE_ROW], "console"),
    );
    renderTimeline({ entries, state: { kind: "ready" } });

    const labels = screen
      .getAllByRole("listitem")
      .map((row) => ["Mark8ly", "Fe3dr", "Console"].filter((name) => row.textContent?.includes(name)));
    expect(labels).toEqual([["Mark8ly"], ["Console"], ["Fe3dr"]]);
  });

  it("does not smuggle the source into a field that carries audit data", () => {
    // `target` is what was acted on and `metadata` is the upstream's own
    // severity/IP/diff. Prefixing either would make the audit record state
    // something the source never recorded — worse than no attribution at all.
    renderTimeline({ entries: [PRODUCT_ROW], state: { kind: "ready" } });
    expect(
      screen.getByText("ops@mark8ly.com tenant.suspend tenant:acme"),
    ).toBeInTheDocument();
  });

  it("renders the empty state rather than an empty list", () => {
    renderTimeline({ state: { kind: "empty" } });
    expect(screen.getByText(TIMELINE_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("states what the timeline does not reach back to", () => {
    // The two sources truncate differently. Not saying so lets an operator
    // read the oldest row on screen as the oldest row that exists.
    renderTimeline({ entries: withSource([CONSOLE_ROW], "console") });
    expect(screen.getByText(TIMELINE_SCOPE_NOTE)).toBeInTheDocument();
  });
});

describe("metadata is readable, and complete", () => {
  /** A mark8ly row's metadata, exactly as `stringifyMetadata` emits it. */
  const MARK8LY_METADATA =
    '{"severity":"critical","status":"success","tenant":"acme","ip":"10.0.0.1"}';

  function rowWithMetadata(metadata: string): SourcedAuditEntry {
    return { ...PRODUCT_ROW, metadata };
  }

  it("renders each key with its value instead of a line of JSON", () => {
    // The complaint this closes: the row used to print the whole object
    // verbatim, braces and quotes included, beside the actor.
    renderTimeline({ entries: [rowWithMetadata(MARK8LY_METADATA)] });

    expect(screen.getByText("severity")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.queryByText(MARK8LY_METADATA)).not.toBeInTheDocument();
  });

  it("shows EVERY key, not a readable subset", () => {
    // GUARDS THE GUARD, and it is the assertion that matters most here. A
    // formatter that renders the two keys it recognises passes the test above
    // while quietly hiding the rest of an audit record — worse than the JSON,
    // which at least never understated how much there was.
    renderTimeline({ entries: [rowWithMetadata(MARK8LY_METADATA)] });

    for (const key of ["severity", "status", "tenant", "ip"]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    for (const value of ["critical", "success", "acme", "10.0.0.1"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
  });

  it("keeps a key this build has never heard of", () => {
    // mark8ly spreads `...row.metadata` into its object, so per-event keys
    // arrive that no whitelist here could anticipate. The unusual field is
    // exactly the one an operator is reading the row for.
    renderTimeline({
      entries: [rowWithMetadata('{"severity":"high","quarantine_reason":"rate-limit"}')],
    });

    expect(screen.getByText("quarantine_reason")).toBeInTheDocument();
    expect(screen.getByText("rate-limit")).toBeInTheDocument();
  });

  it("renders a nested diff as JSON under its own label, not as [object Object]", () => {
    // kora's and homechef's metadata is `{before, after}` and both values are
    // objects. `String(value)` would render each as "[object Object]" — the
    // one formatting that destroys the content outright.
    renderTimeline({
      entries: [rowWithMetadata('{"before":{"plan":"free"},"after":{"plan":"pro"}}')],
    });

    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText('{"plan":"free"}')).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.getByText('{"plan":"pro"}')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it("shows the raw string when it is not a JSON object", () => {
    // A formatter is the wrong place to discover a producer changed shape.
    // Showing the operator the record as it arrived is the honest failure.
    renderTimeline({ entries: [rowWithMetadata("not json at all")] });
    expect(screen.getByText("not json at all")).toBeInTheDocument();
  });

  it("parses to fields, or to null when there is nothing to lay out", () => {
    expect(parseMetadataFields('{"a":1,"b":"x"}')).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "x" },
    ]);
    // `null`, arrays and `{}` all take the render-verbatim path: no producer
    // emits them, and guessing at how to label one invents a reading of an
    // audit record.
    expect(parseMetadataFields("null")).toBeNull();
    expect(parseMetadataFields('["a"]')).toBeNull();
    expect(parseMetadataFields("{}")).toBeNull();
    expect(parseMetadataFields("{oops")).toBeNull();
  });

  it("renders no metadata block for a row that has none", () => {
    // PRODUCT_ROW carries no metadata, and `stringifyMetadata` returns
    // undefined rather than "{}" precisely so an empty strip never appears.
    renderTimeline({ entries: [PRODUCT_ROW] });
    expect(screen.queryByRole("definition")).not.toBeInTheDocument();
  });
});

describe("upstream failures are visible, not swallowed", () => {
  const FAILURES: AuditSourceFailure[] = [
    { source: "kora", message: "kora: responded 502" },
  ];

  it("names the failed source and the reason", () => {
    // A timeline that silently omits a product is worse than one that says
    // "Kora unavailable": a reader draws conclusions from what is ABSENT from
    // an audit log.
    renderTimeline({
      entries: [PRODUCT_ROW],
      failures: FAILURES,
    });

    expect(screen.getByText("This timeline is incomplete")).toBeInTheDocument();
    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(screen.getByText(/kora: responded 502/)).toBeInTheDocument();
  });

  it("renders nothing at all when every source answered", () => {
    // GUARDS THE GUARD. The test above passes on a banner rendered
    // unconditionally, and "the surface renders without error" passes even if
    // the failure list is dropped on the floor entirely. This is the assertion
    // that fails when the banner stops depending on its input.
    const { container } = render(<IncompleteSources failures={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still surfaces failures when the timeline itself has no rows", () => {
    // The worst case: every product failed, nothing to show, and the reason
    // must not be replaced by "no audit events recorded".
    renderTimeline({
      entries: [],
      state: { kind: "empty" },
      failures: FAILURES,
    });
    expect(screen.getByText(/kora: responded 502/)).toBeInTheDocument();
  });

  it("counts the sources it lists", () => {
    render(
      <IncompleteSources
        failures={[
          { source: "kora", message: "kora: responded 502" },
          { source: "homechef", message: "homechef: request failed" },
        ]}
      />,
    );
    expect(screen.getByText(/2 sources could not be read/)).toBeInTheDocument();
    expect(screen.getByText("Fe3dr")).toBeInTheDocument();
  });
});
