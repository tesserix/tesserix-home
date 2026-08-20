import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import { RankedBars, type RankedBarRow } from "@/components/kit/ranked-bars";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// `surface-state`, not `states`: this is a server component, and `states.tsx`
// is a "use client" module whose exports become client references.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import {
  fetchAiUsageBreakdown,
  fetchAiUsageEvents,
  fetchAiUsageGuardrails,
  fetchAiUsageSummary,
  type AiUsageQuery,
} from "@/lib/platform-api";
import {
  cacheHitRate,
  costFormatter,
  tokenFormatter,
  AI_USAGE_WINDOWS,
  type AiUsageBreakdown,
  type AiUsageEvents,
  type AiUsageGuardrails,
  type AiUsageSummary,
} from "@/lib/ai-usage";
import { BreakdownTable } from "./breakdown-table";
import { EventsTable } from "./events-table";
import { GuardrailRules } from "./guardrail-rules";
import { UsageFilters } from "./usage-filters";
import { UsageTrend } from "./usage-trend";

/**
 * AI cost and token usage, as observed at the agentgateway data plane.
 *
 * The gateway is the one place that sees provider, model, token counts,
 * guardrail verdicts and rate-limit refusals for every product at once, which
 * is why this surface reads from it rather than from each product's own
 * accounting. It is NOT the bill: Kora's own ledger remains the billing
 * authority, and the two differ by exactly the traffic the gateway refused
 * before it reached a provider. The description says so on the page, because
 * an operator comparing the two numbers deserves to know why they differ.
 *
 * Six reads, each with its own state: a parked guardrail query must not take
 * the cost tiles down with it.
 */

const WINDOW_LABELS: Record<string, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export const DEFAULT_WINDOW = "24h";

/** Longer than any provider or product slug the gateway emits; a URL is
 *  untrusted input and an unbounded value has no business reaching the API. */
const MAX_FILTER_VALUE = 64;

export interface AiUsageFilters {
  window: string;
  product?: string;
  provider?: string;
}

/**
 * The filter descriptors.
 *
 * Provider options are derived from the providers the window actually shows,
 * not from a hard-coded list: the estate adds providers by editing gateway
 * config, and a list here would be wrong the day after it was written. The
 * applied value is always included so a saved URL round-trips even when that
 * provider has served nothing in this window.
 */
export function aiUsageFilters(
  providers: readonly string[],
  applied?: string,
): FilterDescriptor[] {
  const options = new Set(providers.filter((provider) => provider !== ""));
  if (applied) options.add(applied);

  return [
    {
      key: "window",
      label: "Window",
      type: "select",
      options: AI_USAGE_WINDOWS.map((key) => ({ value: key, label: WINDOW_LABELS[key] ?? key })),
    },
    {
      key: "product",
      label: "Product",
      type: "select",
      options: ESTATE.map((product) => ({ value: product.context, label: product.name })),
    },
    {
      key: "provider",
      label: "Provider",
      type: "select",
      options: [...options].sort().map((provider) => ({ value: provider, label: provider })),
    },
  ];
}

export type AiUsageSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the filters out of the URL.
 *
 * The window is checked against the vocabulary because an unknown one is a 422
 * from the API — a whole blank page for a typo. Product and provider are passed
 * through when they are plausible strings: their vocabularies are the estate's
 * and the gateway's, both of which change without this file, and narrowing to
 * something that served nothing is `filtered-empty`, which is the truth.
 */
export function readAiUsageFilters(searchParams: AiUsageSearchParams): AiUsageFilters {
  const one = (key: string): string | undefined => {
    const raw = searchParams[key];
    // A repeated param arrives as an array; the API takes one value per key.
    if (typeof raw !== "string") return undefined;
    const value = raw.trim();
    return value === "" || value.length > MAX_FILTER_VALUE ? undefined : value;
  };

  const window = one("window");
  return {
    window: window && (AI_USAGE_WINDOWS as readonly string[]).includes(window)
      ? window
      : DEFAULT_WINDOW,
    product: one("product"),
    provider: one("provider"),
  };
}

/** The applied filters as the bar's display values. */
export function toFilterValues(filters: AiUsageFilters): FilterValues {
  const values: FilterValues = { window: filters.window };
  if (filters.product) values.product = filters.product;
  if (filters.provider) values.provider = filters.provider;
  return values;
}

/** True when the reader has narrowed away from the default view, which is what
 *  separates "nothing has happened" from "nothing matches". */
export function isNarrowed(filters: AiUsageFilters): boolean {
  return Boolean(filters.product) || Boolean(filters.provider) || filters.window !== DEFAULT_WINDOW;
}

export function usageState(input: {
  error: unknown;
  rows: readonly unknown[];
  filtered: boolean;
}): SurfaceState {
  return resolveState({
    // The page awaits its fetches before rendering; Suspense covers the wait.
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

/**
 * A breakdown as ranked bars, ranked by requests rather than by cost.
 *
 * `RankedBars` renders counts with `toLocaleString`, which turns $0.0042 into
 * "0.004" and a shape into a lie. Request share is a count, is honestly
 * rendered, and the money is one tab away in a table that formats it properly.
 */
export function toRankedRows(rows: readonly { key: string; requests: number }[]): RankedBarRow[] {
  const total = rows.reduce((acc, row) => acc + row.requests, 0);
  return rows.map((row) => ({
    key: row.key || "unattributed",
    label: row.key || "Unattributed",
    count: row.requests,
    share: total === 0 ? 0 : row.requests / total,
  }));
}

export const EMPTY_MESSAGES = {
  overview: "No AI traffic reached the gateway in this window.",
  breakdown: "Nothing to break down: no AI traffic in this window.",
  guardrails: "No guardrail fired in this window.",
  events: "No gateway requests in this window.",
} as const;

function settled<T>(result: PromiseSettledResult<T>): { data: T | null; error: unknown } {
  return result.status === "fulfilled"
    ? { data: result.value, error: null }
    : { data: null, error: result.reason };
}

export default async function AiUsagePage({
  searchParams,
}: {
  searchParams: Promise<AiUsageSearchParams>;
}) {
  const filters = readAiUsageFilters(await searchParams);
  const filtered = isNarrowed(filters);
  const query: AiUsageQuery = {
    window: filters.window,
    product: filters.product,
    provider: filters.provider,
  };

  // `allSettled`, not `all`: one failing read must not blank the other five.
  const [
    summaryResult,
    productResult,
    capabilityResult,
    providerResult,
    modelResult,
    guardrailResult,
    eventsResult,
  ] = await Promise.allSettled([
    fetchAiUsageSummary(query),
    fetchAiUsageBreakdown("product", query),
    fetchAiUsageBreakdown("capability", query),
    fetchAiUsageBreakdown("provider", query),
    fetchAiUsageBreakdown("model", query),
    fetchAiUsageGuardrails(query),
    fetchAiUsageEvents(query),
  ]);

  const summary = settled<AiUsageSummary>(summaryResult);
  const products = settled<AiUsageBreakdown>(productResult);
  const capabilities = settled<AiUsageBreakdown>(capabilityResult);
  const providers = settled<AiUsageBreakdown>(providerResult);
  const models = settled<AiUsageBreakdown>(modelResult);
  const guardrails = settled<AiUsageGuardrails>(guardrailResult);
  const events = settled<AiUsageEvents>(eventsResult);

  const totals = summary.data?.totals ?? null;
  const seriesState = usageState({
    error: summary.error,
    rows: summary.data?.series ?? [],
    filtered,
  });
  const tileState = usageState({ error: summary.error, rows: totals ? [totals] : [], filtered });

  const breakdownState = (data: AiUsageBreakdown | null, error: unknown): SurfaceState =>
    usageState({ error, rows: data?.rows ?? [], filtered });

  const descriptors = aiUsageFilters(
    (providers.data?.rows ?? []).map((row) => row.key),
    filters.provider,
  );

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="AI cost and token usage"
        description="Every product's LLM traffic as the AI gateway saw it — spend, tokens, models and refusals. Not the bill: refused traffic never reached a provider."
      />

      <UsageFilters descriptors={descriptors} values={toFilterValues(filters)} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Spend"
          value={totals ? costFormatter(totals.costUsd) : ""}
          state={totals ? undefined : tileState}
        />
        <StatTile
          label="Requests"
          value={totals ? totals.requests.toLocaleString() : ""}
          state={totals ? undefined : tileState}
        />
        <StatTile
          label="Tokens"
          value={totals ? tokenFormatter(totals.tokens.input + totals.tokens.output) : ""}
          delta={
            totals ? `${Math.round(cacheHitRate(totals.tokens) * 100)}% of input cached` : undefined
          }
          state={totals ? undefined : tileState}
        />
        <StatTile
          label="Refused"
          // Blocked, rate-limited and errored together: from the caller's side
          // all three are a request that got no answer.
          value={totals ? (totals.blocked + totals.rateLimited + totals.errors).toLocaleString() : ""}
          state={totals ? undefined : tileState}
        />
      </div>

      <SurfaceTabs
        label="AI usage views"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: (
              <div className="flex flex-col gap-8">
                <UsageTrend
                  points={summary.data?.series ?? []}
                  bucketSeconds={summary.data?.window.bucketSeconds ?? 3600}
                  state={seriesState}
                  emptyMessage={EMPTY_MESSAGES.overview}
                />
                <RankedBars
                  title="Requests by product"
                  description="Share of gateway requests. Cost per product is on the Products tab."
                  rows={toRankedRows(products.data?.rows ?? [])}
                  state={breakdownState(products.data, products.error)}
                  emptyMessage={EMPTY_MESSAGES.breakdown}
                />
              </div>
            ),
          },
          {
            id: "products",
            label: "Products",
            content: (
              <div className="flex flex-col gap-8">
                <BreakdownTable
                  title="By product"
                  description="What each product spent, and how much of its input came from cache."
                  axisLabel="Product"
                  rows={products.data?.rows ?? []}
                  state={breakdownState(products.data, products.error)}
                  emptyMessage={EMPTY_MESSAGES.breakdown}
                />
                <BreakdownTable
                  title="By capability"
                  description="The sub-usage within each product — which feature spent the money."
                  axisLabel="Capability"
                  rows={capabilities.data?.rows ?? []}
                  state={breakdownState(capabilities.data, capabilities.error)}
                  emptyMessage={EMPTY_MESSAGES.breakdown}
                />
              </div>
            ),
          },
          {
            id: "models",
            label: "Models and providers",
            content: (
              <div className="flex flex-col gap-8">
                <BreakdownTable
                  title="By provider"
                  axisLabel="Provider"
                  rows={providers.data?.rows ?? []}
                  state={breakdownState(providers.data, providers.error)}
                  emptyMessage={EMPTY_MESSAGES.breakdown}
                />
                <BreakdownTable
                  title="By model"
                  description="The model the request asked for; a provider may answer on another."
                  axisLabel="Model"
                  rows={models.data?.rows ?? []}
                  state={breakdownState(models.data, models.error)}
                  emptyMessage={EMPTY_MESSAGES.breakdown}
                />
              </div>
            ),
          },
          {
            id: "guardrails",
            label: "Guardrails",
            content: (
              <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-3">
                  <StatTile
                    label="Blocked"
                    value={guardrails.data ? guardrails.data.blocked.toLocaleString() : ""}
                    state={
                      guardrails.data
                        ? undefined
                        : usageState({ error: guardrails.error, rows: [], filtered })
                    }
                  />
                  <StatTile
                    label="Masked"
                    value={guardrails.data ? guardrails.data.masked.toLocaleString() : ""}
                    state={
                      guardrails.data
                        ? undefined
                        : usageState({ error: guardrails.error, rows: [], filtered })
                    }
                  />
                  <StatTile
                    label="Rate limited"
                    value={guardrails.data ? guardrails.data.rateLimited.toLocaleString() : ""}
                    state={
                      guardrails.data
                        ? undefined
                        : usageState({ error: guardrails.error, rows: [], filtered })
                    }
                  />
                </div>
                <GuardrailRules
                  rules={guardrails.data?.rules ?? []}
                  state={usageState({
                    error: guardrails.error,
                    rows: guardrails.data?.rules ?? [],
                    filtered,
                  })}
                  emptyMessage={EMPTY_MESSAGES.guardrails}
                />
              </div>
            ),
          },
          {
            id: "events",
            label: "Events",
            content: (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  The newest requests, as the gateway recorded them. No prompt or completion
                  text is stored, here or in the ledger.
                </p>
                <EventsTable
                  events={events.data?.events ?? []}
                  state={usageState({
                    error: events.error,
                    rows: events.data?.events ?? [],
                    filtered,
                  })}
                  emptyMessage={EMPTY_MESSAGES.events}
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
