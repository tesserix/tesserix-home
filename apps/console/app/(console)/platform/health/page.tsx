import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { routeCapability } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { requiresCapability } from "@/lib/internal-access";
import { readEstateHealth } from "@/lib/health";
import { HEALTH_PRESENTATION, describeHealth } from "@/lib/health-presentation";

/**
 * The estate's health, spelled out — reached from the header indicator.
 *
 * # Gated on `read`, never `platform`
 *
 * The header indicator renders for every operator, on every page, regardless
 * of what they hold. This page is where it links to. Gating the page above
 * `read` would give an operator who can SEE the indicator a 403 the moment
 * they click it — worse than no link at all, and a defect this codebase has
 * already shipped twice. `routeCapability` reads the requirement from
 * `ROUTES["platform.serviceHealth"]` rather than a literal here, so the route
 * table stays the one place that decision is recorded — see the ablation test
 * below, which is what actually enforces that.
 *
 * # Three parts
 *
 * 1. The state itself, in the same shapes and words as the indicator
 *    (`lib/health-presentation.ts`, shared rather than restated).
 * 2. What was measured — workload and database counts, and the degraded
 *    reason as text. The reason previously lived only in a `title`
 *    attribute; this is the first place it is reachable without a mouse.
 * 3. What is NOT measured yet — Uptime, Observability and Custom domains,
 *    the three concerns whose rail entries move here (Task 2). Named
 *    plainly, in the unmeasured ring's own visual language, never as a
 *    "SOON" badge — that would just relocate the placeholder this page
 *    exists to replace.
 *
 * Databases and Service health are deliberately absent from part 3: they are
 * measured, and parts 1 and 2 are what show them.
 */

const NOT_YET_MEASURED = ["Uptime", "Observability", "Custom domains"] as const;

export default async function HealthPage() {
  const session = await getCurrentSession();
  const mayView =
    !requiresCapability() ||
    hasCapability(session?.roles, routeCapability("platform.serviceHealth"));

  if (!mayView) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          You do not have permission to view estate health.
        </p>
      </Shell>
    );
  }

  const health = await readEstateHealth();
  const presentation = HEALTH_PRESENTATION[health.state];
  const unmeasuredPresentation = HEALTH_PRESENTATION.unmeasured;
  // Multiple problems arrive joined with "; " (see the Go classifier) — one
  // line per problem reads far better than one long run-on sentence.
  const reasonLines = health.reason ? health.reason.split("; ") : [];

  return (
    <Shell>
      <section aria-labelledby="health-state-heading" className="flex flex-col gap-2">
        <h2 id="health-state-heading" className="text-sm font-medium text-muted-foreground">
          State
        </h2>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={presentation.dot} />
          <span className={`text-base font-medium ${presentation.text}`}>
            {presentation.label}
          </span>
          {health.stale ? (
            <span className="text-sm text-muted-foreground">(stale)</span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{describeHealth(health)}</p>
      </section>

      <section aria-labelledby="health-measured-heading" className="flex flex-col gap-3">
        <h2 id="health-measured-heading" className="text-sm font-medium text-muted-foreground">
          What was measured
        </h2>
        <dl className="grid grid-cols-2 gap-4 sm:max-w-md">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">Workloads ready</dt>
            <dd className="text-lg font-medium text-foreground">
              {health.workloads.ready} / {health.workloads.total}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">Databases ready</dt>
            <dd className="text-lg font-medium text-foreground">
              {health.databases.ready} / {health.databases.total}
            </dd>
          </div>
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
