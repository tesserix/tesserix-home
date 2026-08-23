import { ConsolePageHeader } from "@/components/kit/page-header";
import { readEstateHealth } from "@/lib/health";
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
 *    A section nothing measured says so instead of printing a count.
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
    { name: "Workloads", counts: health.workloads },
    { name: "Databases", counts: health.databases },
  ] as const;

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
        <p className="text-sm text-muted-foreground">{describeHealth(health)}</p>
        {/*
          The header indicator and this page each call `readEstateHealth()`
          separately, and clicking the indicator is a soft navigation — Next
          does not re-render the layout, so the header can still be showing the
          reading from the last hard load while this page renders a fresh one.
          Dating the reading is what lets an operator compare the two.

          RAW ISO, deliberately: this renders on the server and hydrates on the
          client, so a relative age reads the clock and a locale-formatted time
          reads the locale — either is a hydration mismatch.
        */}
        <p className="text-sm text-muted-foreground">
          {health.checkedAt
            ? `Last measured ${health.checkedAt}`
            : "Last measured: unknown — no reading timestamp came back."}
        </p>
      </section>

      <section aria-labelledby="health-measured-heading" className="flex flex-col gap-3">
        <h2 id="health-measured-heading" className="text-sm font-medium text-muted-foreground">
          What was measured
        </h2>
        <dl className="grid grid-cols-2 gap-4 sm:max-w-md">
          {sections.map(({ name, counts }) =>
            anythingMeasured && counts.total > 0 ? (
              <div key={name} className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{name} ready</dt>
                <dd className="text-lg font-medium text-foreground">
                  {counts.ready} / {counts.total}
                </dd>
              </div>
            ) : (
              <div key={name} className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{name}</dt>
                <dd className="flex items-center gap-2 text-sm text-foreground">
                  <span aria-hidden="true" className={unmeasuredPresentation.dot} />
                  <span>Nothing measured this.</span>
                </dd>
              </div>
            ),
          )}
        </dl>
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
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Estate health"
        description="What the console currently measures, and what it does not yet."
      />
      {children}
    </div>
  );
}
