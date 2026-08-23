import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import {
  readEstateHealth,
  type DatabaseItem,
  type HealthCounts,
  type WorkloadItem,
} from "@/lib/health";
import { HEALTH_PRESENTATION, describeHealth } from "@/lib/health-presentation";

/**
 * The estate's health, spelled out — reached from the header indicator.
 *
 * # No view gate, deliberately
 *
 * `middleware.ts` has already established that whoever reaches this page holds
 * a valid session and is internal; no console page gates VIEWING on a
 * capability. The gates that exist are on ACTIONS — `tickets/[id]` on
 * `respond`, `tools` on `mayManage`, `crm/[organisation]` on `hard-delete` —
 * and `/platform/ai-usage`, this page's closest sibling, renders for any
 * internal operator with no gate at all. A page-level view gate here would be
 * the console's first, and under `AUTH_PROVIDER=google` (sessions carry no
 * roles) it would refuse everyone while its siblings rendered normally.
 * `routes.ts` still records `platform` as the route's capability — that field
 * gates DISCOVERABILITY in the rail and palette, which is a different job.
 *
 * # Three parts
 *
 * 1. The state itself, in the same shapes and words as the indicator
 *    (`lib/health-presentation.ts`, shared rather than restated), plus the
 *    timestamp of the reading.
 * 2. What was measured — workload and database counts, and the degraded
 *    reason as text. The reason is already reachable without a mouse from the
 *    indicator's `aria-label`; this is the first place it is VISIBLE AS TEXT.
 *    The counts render as `StatTile`s, the same dashboard-card primitive
 *    `/platform/ai-usage` uses for its own numbers — a section nothing
 *    measured uses the tile's own `instrumentation-unavailable` state
 *    ("Not measured") rather than printing a count. When the payload carries
 *    per-item detail (a newer platform-api; see `lib/health.ts`'s
 *    `HealthCounts.items`), each tile is followed by a `dl` of its rows — the
 *    tile stays the summary, the rows are the detail underneath it. An older
 *    platform-api answers with no `items` at all, which `parseHealth`
 *    represents as `null` rather than `[]`; that section then renders exactly
 *    as it did before this existed, with no row list and no empty table.
 * 3. What is NOT measured yet — Uptime, Observability and Custom domains,
 *    the three concerns whose rail entries move here (Task 2). Named
 *    plainly, in the unmeasured ring's own visual language, never as a
 *    "SOON" badge — that would just relocate the placeholder this page
 *    exists to replace.
 *
 * Databases and Service health are deliberately absent from part 3 WHEN
 * MEASURED: parts 1 and 2 are what show them. When a reading did not happen,
 * part 2 says so for each section rather than claiming a taxonomy nothing
 * produced.
 */

const NOT_YET_MEASURED = ["Uptime", "Observability", "Custom domains"] as const;

// The state word is the page's headline, so it takes the page's own emphasis
// rather than `presentation.text`. That field is tuned for the header, where
// the indicator is muted chrome; reusing it here renders "Healthy" and
// "Unmeasured" — the two states this feature exists to distinguish — in the
// same grey as the section labels around them. The header's own appearance is
// unchanged.
const STATE_WORD = "text-base font-medium text-foreground";

/**
 * Formats a reading timestamp for display, deterministically.
 *
 * Fixed locale ("en-GB") and an explicit `timeZone: "UTC"` — never the
 * viewer's own locale or timezone, and never a relative age ("40 seconds
 * ago"). Either of those would make the rendered text depend on WHO is
 * looking rather than WHAT was measured, which is the same non-determinism
 * the raw-ISO approach below was originally guarding against, just moved
 * into the formatter instead of removed.
 *
 * # Why the NaN guard is not defensive padding
 *
 * `checked_at` is an untrusted wire field. `lib/health.ts` only type-checks
 * it (`typeof record.checked_at === "string"`) — it never parses it — so a
 * version skew, a truncated value, or an out-of-range ISO-shaped value such
 * as `"2026-13-45T99:99:99Z"` all reach here as a perfectly well-typed
 * string that `new Date()` turns into an Invalid Date.
 * `Intl.DateTimeFormat.format`
 * THROWS `RangeError: Invalid time value` on one, inside an async server
 * component, and the whole page renders its error boundary instead — at
 * exactly the moment an operator went looking for estate health.
 *
 * Every other field on this payload is deliberately distrusted (`parseHealth`
 * downgrades a `healthy` claim that counted nothing); this one does not get
 * to be the exception because it gained a formatter. An unparseable value
 * falls back to printing the raw string, which is what this line did before
 * the formatter existed and is still the honest rendering of "the API sent
 * this". The machine-readable `dateTime` attribute carries the raw value
 * either way, parseable or not.
 */
function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${formatted} UTC`;
}

/**
 * Whether a single section (Workloads or Databases) has a real reading to
 * show, independently of the other section and of the page's overall state.
 *
 * Nothing measured means nothing measured EITHER section (`anythingMeasured`
 * false covers that), but a section can also individually come back empty —
 * a partial payload, a source that did not answer — while its sibling is
 * fine. A `0 / 0` in either case asserts an instrumentation taxonomy at the
 * exact moment nothing counted it, and reads as "there are zero of these"
 * rather than "nothing counted them".
 */
function sectionMeasured(anythingMeasured: boolean, counts: HealthCounts<unknown>): boolean {
  return anythingMeasured && counts.total > 0;
}

export default async function HealthPage() {
  const health = await readEstateHealth();
  const presentation = HEALTH_PRESENTATION[health.state];
  const unmeasuredPresentation = HEALTH_PRESENTATION.unmeasured;
  // Multiple problems arrive joined with "; " (see the Go classifier) — one
  // line per problem reads far better than one long run-on sentence.
  const reasonLines = health.reason ? health.reason.split("; ") : [];
  // Nothing measured means nothing measured EITHER section. A `0 / 0` under
  // "Workloads ready" in that state asserts an instrumentation taxonomy at the
  // exact moment no instrument reported, and reads as "there are zero
  // workloads" rather than "nothing counted them".
  const anythingMeasured = health.state !== "unmeasured";
  const sections = [
    { name: "Workloads", counts: health.workloads, items: health.workloads.items },
    { name: "Databases", counts: health.databases, items: health.databases.items },
  ] as const;
  // The healthy-state sentence from `describeHealth` is nothing but
  // "N of M workloads and N of M databases ready" — a prose restatement of
  // exactly the counts the "What was measured" section renders a few lines
  // below, as a heading over the same numbers' row detail. Degraded and
  // unmeasured don't have this problem: degraded's clause is the REASON
  // (kept — the row list has no equivalent for it), and unmeasured has no
  // counts clause at all. `stale` always earns its own clause too (it names
  // a fact the timestamp line below doesn't: that the CURRENT reading could
  // not be taken), so a stale healthy reading still prints the sentence.
  const showStateSentence = health.state !== "healthy" || health.stale;

  return (
    <Shell>
      <section aria-labelledby="health-state-heading" className="flex flex-col gap-2">
        <h2 id="health-state-heading" className="text-sm font-medium text-muted-foreground">
          State
        </h2>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={presentation.dot} />
          <span className={STATE_WORD}>{presentation.label}</span>
          {health.stale ? (
            <span className="text-sm text-muted-foreground">(stale)</span>
          ) : null}
        </div>
        {showStateSentence ? (
          <p className="text-sm text-muted-foreground">{describeHealth(health)}</p>
        ) : null}
        {/*
          The header indicator and this page each call `readEstateHealth()`
          separately, and clicking the indicator is a soft navigation — Next
          does not re-render the layout, so the header can still be showing the
          reading from the last hard load while this page renders a fresh one.
          Dating the reading is what lets an operator compare the two.

          FORMATTED, not raw ISO: this page is a SERVER component that never
          hydrates on the client — there is no second render to mismatch
          against, so the hydration hazard the raw-ISO choice was guarding
          against does not apply here (it does apply to the header indicator,
          a "use client" component, which is why THAT surface stays raw).
          What still applies is determinism: the format below is fixed
          UTC/`en-GB`, never the viewer's own locale or timezone, and never a
          relative age — see `formatCheckedAt`. The machine-readable ISO value
          is preserved on `dateTime` either way.
        */}
        <p className="text-sm text-muted-foreground">
          {health.checkedAt ? (
            <>
              <span>Last measured</span>{" "}
              <time dateTime={health.checkedAt}>{formatCheckedAt(health.checkedAt)}</time>
            </>
          ) : (
            "Last measured: unknown — no reading timestamp came back."
          )}
        </p>
      </section>

      <section aria-labelledby="health-measured-heading" className="flex flex-col gap-4">
        <h2 id="health-measured-heading" className="text-sm font-medium text-muted-foreground">
          What was measured
        </h2>
        {/*
          Two `StatTile`s — the same dashboard-card primitive every other
          stat on the console uses (see `ai-usage/page.tsx`'s tile row) —
          rather than a bespoke two-column `dl`. That row was the page's
          narrowest, most cramped element (capped at `sm:max-w-md`, 448px,
          split into two ~200px halves); tiles built for the full grid fill
          the width the rest of the console's dashboards already use.

          Two tiles, not the four-wide house grid `ai-usage` uses: this page
          only has two real numbers to show, and forcing a `lg:grid-cols-4`
          template here would leave two tiles-shaped holes — the exact "empty
          on the right" complaint this change exists to fix, just moved one
          level down. `sm:grid-cols-2` lets both tiles claim real width on
          any screen at least `sm`, and stack on mobile.

          Each tile also carries the `unmeasured` state itself, via
          `StatTile`'s own `instrumentation-unavailable` surface state — the
          same "we are not measuring this" vocabulary every other parked
          stat on the console already uses — instead of a bespoke "Nothing
          measured this" branch invented for this one page. `sectionMeasured`
          below is what decides, per section, independently of the other:
          a database section reporting zero total under an otherwise
          `degraded` reading still parks correctly even though workloads is
          fine.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          {sections.map(({ name, counts }) => (
            <StatTile
              key={name}
              // "{name} ready" once there is something to report, bare
              // "{name}" while parked — matching the wording the rest of the
              // page already used for this distinction, so a bare "Databases"
              // never appears next to a real reading and gets mistaken for one.
              label={sectionMeasured(anythingMeasured, counts) ? `${name} ready` : name}
              value={sectionMeasured(anythingMeasured, counts) ? `${counts.ready} / ${counts.total}` : ""}
              state={sectionMeasured(anythingMeasured, counts) ? undefined : { kind: "instrumentation-unavailable" }}
            />
          ))}
        </div>
        {/*
          The per-item detail lives in its own `dl`, separate from the tiles
          above: a `StatTile` has room for one label and one number, not a
          multi-row breakdown, and a row list stuffed inside one would break
          the tile's own layout contract every other stat on the console
          relies on. Rendered only when there is something to list — an
          older platform-api's `items: null`, or a parked section, means no
          `dl` at all, not an empty one.
        */}
        {sections.map(({ name, counts, items }) =>
          sectionMeasured(anythingMeasured, counts) && items && items.length > 0 ? (
            <dl key={name} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{name}</dt>
                {/*
                  The row list lives INSIDE the `dd`, not beside it. The
                  content model for a `dl > div` is one-or-more `dt` followed
                  by one-or-more `dd`; a `ul` sibling is not permitted there,
                  and a screen reader walking the definition list orphans the
                  rows from the term they belong to.
                */}
                <dd className="flex flex-col gap-1">
                  <RowList total={counts.total} shown={items.length}>
                    {name === "Workloads"
                      ? (items as readonly WorkloadItem[]).map((item, index) => (
                          // Index-QUALIFIED, not the name alone. Kubernetes
                          // names are unique per namespace per kind, so a
                          // collision is not reachable from a live cluster —
                          // but `parseHealth` does not dedupe, and a replayed
                          // or hand-crafted payload with two rows of the same
                          // name would give React duplicate keys and licence
                          // to mis-reconcile them. Qualifying the key here is
                          // one line; deduping in the parser would silently
                          // DROP a row the API sent, which is the opposite of
                          // what this page is for.
                          <WorkloadRow key={`${index}-${item.name}`} item={item} />
                        ))
                      : (items as readonly DatabaseItem[]).map((item, index) => (
                          <DatabaseRow key={`${index}-${item.name}`} item={item} />
                        ))}
                  </RowList>
                </dd>
              </div>
            </dl>
          ) : null,
        )}
        {reasonLines.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm text-foreground">
            {reasonLines.map((line, index) => (
              // Index is stable here: reasonLines is derived fresh from one
              // render's `health.reason` and never reordered or filtered.
              <p key={index}>{line}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="health-unmeasured-heading" className="flex flex-col gap-3">
        <h2 id="health-unmeasured-heading" className="text-sm font-medium text-muted-foreground">
          Not yet measured
        </h2>
        <ul className="flex flex-col gap-2">
          {NOT_YET_MEASURED.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <span aria-hidden="true" className={unmeasuredPresentation.dot} />
              <span className="text-sm text-foreground">
                {name} — nothing measures this yet.
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  // `gap-10` here, deliberately wider than any gap used inside a section
  // (`gap-1`–`gap-8`): State / What was measured / Not yet measured are three
  // distinct groups, and a flat spacing scale across the whole page — the
  // original bug — gives the eye no rhythm to tell a section break from a
  // row break.
  return (
    <div className="flex flex-col gap-10">
      <ConsolePageHeader
        title="Estate health"
        description="What the console currently measures, and what it does not yet."
      />
      {children}
    </div>
  );
}

/**
 * A row list, and — when it is shorter than the count above it — a line
 * saying so.
 *
 * `total` comes off the payload; the rows come from the item parser, which
 * independently drops entries it cannot trust. Nothing reconciles the two, so
 * `{total: 8, items: [<one malformed>, <one good>]}` renders "Workloads ready
 * 8 / 8" above exactly ONE row — and an operator reads a row list as the
 * inventory and concludes the estate has one workload. Neither truncating the
 * count nor inventing the missing rows is honest; saying how many are shown
 * is.
 */
function RowList({
  total,
  shown,
  children,
}: {
  total: number;
  shown: number;
  children: React.ReactNode;
}) {
  return (
    <>
      {shown !== total ? (
        <span className="text-xs text-muted-foreground">
          showing {shown} of {total}
        </span>
      ) : null}
      <ul className="flex flex-col gap-1 pt-1">{children}</ul>
    </>
  );
}

/**
 * One workload's row: name, `ready / desired`, marked when the classifier
 * failed it.
 *
 * The verdict is `item.ok` — the classifier's own, carried on the wire — and
 * is deliberately NOT re-derived from the counts here. See `lib/health.ts`'s
 * `itemOK` for why, and for what an older platform-api's rows fall back to.
 *
 * The marker reuses `HEALTH_PRESENTATION.degraded` — the same diamond/amber
 * the state section uses for "Degraded" — rather than a fourth colour
 * invented for this row list. The dot alone is never the only carrier: a
 * failed row also says so as TEXT, so the marker survives a monochrome
 * rendering as well as a colour-blind reader, same as the state indicator
 * above it.
 */
function WorkloadRow({ item }: { item: WorkloadItem }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {item.ok ? null : (
        <span aria-hidden="true" className={HEALTH_PRESENTATION.degraded.dot} />
      )}
      {/*
        `min-w-0 flex-1 truncate` on the name, `whitespace-nowrap` on the
        count: the name's flex box always absorbs whatever width is left in
        the row, so the count that follows it lands at the same horizontal
        position on every row regardless of how long the name is — a column,
        without a grid. `title` keeps the full name reachable when truncated.
      */}
      <span className="min-w-0 flex-1 truncate text-foreground" title={item.name}>
        {item.name}
      </span>
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {item.ready} / {item.desired}
      </span>
      {item.ok ? null : (
        <span className="whitespace-nowrap text-muted-foreground">— short of target</span>
      )}
    </li>
  );
}

/**
 * One database's row: name, `ready / instances`, phase, marked when the
 * classifier failed it.
 *
 * A database fails for THREE reasons the counts alone cannot show: short
 * instances, zero instances, and a phase CNPG does not consider settled. A
 * mid-failover cluster reports `1 / 1` with the estate summary reading
 * `0 / 1`, so the counts are exactly the wrong thing to read the verdict off
 * — hence `item.ok`, and hence the phase's own class changing with it. An
 * operator must be able to find the bad row by scanning, not by reading and
 * interpreting every phase string on the page.
 *
 * See {@link WorkloadRow} for why the marker is the shared degraded token.
 */
function DatabaseRow({ item }: { item: DatabaseItem }) {
  // The counts-specific wording only applies when the COUNTS are what failed.
  // A cluster failed on its phase is not "short of target", and saying so
  // would send an operator looking for a missing instance that is running.
  const short = item.ready < item.instances;
  return (
    <li className="flex items-center gap-2 text-sm">
      {item.ok ? null : (
        <span aria-hidden="true" className={HEALTH_PRESENTATION.degraded.dot} />
      )}
      {/* See {@link WorkloadRow} for why the name truncates and the count doesn't wrap. */}
      <span className="min-w-0 flex-1 truncate text-foreground" title={item.name}>
        {item.name}
      </span>
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {item.ready} / {item.instances}
      </span>
      {item.ok ? null : (
        <span className="whitespace-nowrap text-muted-foreground">
          {short ? "— short of target" : "— not ready"}
        </span>
      )}
      {item.phase ? (
        // A failed row's phase IS the finding, so it does not render in the
        // same muted grey as "Cluster in healthy state". Never the only
        // carrier — the diamond and the "— not ready" text say it too.
        <span className={item.ok ? "text-muted-foreground" : "font-medium text-foreground"}>
          {item.phase}
        </span>
      ) : null}
    </li>
  );
}
