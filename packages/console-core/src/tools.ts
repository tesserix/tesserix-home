/**
 * The estate's internal tools — a directory, not a dashboard.
 *
 * Fifteen-odd tools run behind `*.tesserix.app` and nothing lists them. The
 * answer to "where do I look at X" is currently tribal knowledge or a browser
 * history search. This is the cheapest demonstration of the console's thesis —
 * one place to control every product — and it needs no backend at all.
 *
 * DELIBERATELY NO STATUS. Whether a tool is *up* belongs to the health strip.
 * Mixing the two invites the failure the spec warns about: a tile rendering
 * green because nothing measured it. Several of these expose no status endpoint
 * at all, so a status field here would be honest for some entries and a lie for
 * the rest.
 *
 * Hostnames are derived rather than hardcoded so a non-production console does
 * not link operators at production tools.
 */

export type ToolGroup =
  | "identity"
  | "observability"
  | "delivery"
  | "cost"
  | "reference";

export interface InternalTool {
  readonly name: string;
  /** Subdomain under the tools base domain. */
  readonly subdomain: string;
  /** What it is for, in one line, to someone who has not used it. */
  readonly purpose: string;
  readonly group: ToolGroup;
  /**
   * Anything a visitor needs to know before clicking — a separate login, a
   * different network path. Present only where there is something real to say:
   * a field of "unknown" would be noise, and guessing would be worse.
   */
  readonly note?: string;
}

/** Display order. Identity first because it gates everything else. */
export const TOOL_GROUPS: ReadonlyArray<{
  readonly key: ToolGroup;
  readonly label: string;
}> = [
  { key: "identity", label: "Identity and secrets" },
  { key: "observability", label: "Observability" },
  { key: "delivery", label: "Delivery" },
  { key: "cost", label: "Cost" },
  { key: "reference", label: "Reference" },
] as const;

export const INTERNAL_TOOLS: readonly InternalTool[] = [
  {
    name: "Zitadel",
    subdomain: "auth",
    purpose: "Identity platform. Operators, organisations, projects and roles.",
    group: "identity",
  },
  {
    name: "Secret service",
    subdomain: "secret-service",
    purpose:
      "Admin console for OpenBao and GCP Secret Manager, and which namespaces may read each secret.",
    group: "identity",
    // Recorded because it is deliberate rather than an oversight: the tool
    // authenticates through its own Google flow and allowlist so that signing
    // in stays possible when the shared identity path is not.
    note: "Separate login — independent of the platform's identity on purpose.",
  },
  {
    name: "Grafana",
    subdomain: "grafana",
    purpose: "Dashboards and charts over the metrics pipeline.",
    group: "observability",
  },
  {
    name: "Observability",
    subdomain: "observability",
    purpose: "Tesserix's own OTel trace and log explorer.",
    group: "observability",
  },
  {
    name: "Prometheus",
    subdomain: "prometheus",
    purpose: "Raw metric queries, when a Grafana panel is not enough.",
    group: "observability",
  },
  {
    name: "Alertmanager",
    subdomain: "alertmanager",
    purpose: "Firing alerts, silences and routing.",
    group: "observability",
  },
  {
    name: "Kibana",
    subdomain: "kibana",
    purpose: "Full-text log search across workloads, when you have a message but no trace.",
    group: "observability",
  },
  {
    name: "OpenPanel",
    subdomain: "analytics",
    purpose: "Self-hosted product analytics — page views and events.",
    group: "observability",
  },
  {
    name: "ArgoCD",
    subdomain: "argocd",
    purpose: "What is deployed, and whether it matches git.",
    group: "delivery",
    // From the cluster's routing config: ArgoCD is exposed directly rather
    // than through the Istio gateway every other host uses.
    note: "Reached outside the Istio gateway; its own login.",
  },
  {
    name: "Kargo",
    subdomain: "kargo",
    purpose: "Promotes images between stages. Where a stuck rollout shows up.",
    group: "delivery",
  },
  {
    name: "Kubecost",
    subdomain: "kubecost",
    purpose: "Cluster spend by namespace and workload.",
    group: "cost",
  },
  {
    name: "Cost estimator",
    subdomain: "costestimator",
    purpose: "Models the cost of a change before making it.",
    group: "cost",
  },
  {
    name: "Agentic registry",
    subdomain: "aregistry",
    purpose: "Registry for agentic artifacts — skills, tools, MCPs, prompts.",
    group: "reference",
  },
  {
    name: "Docs",
    subdomain: "docs",
    purpose: "Engineering documentation.",
    group: "reference",
  },
] as const;

/**
 * Build a tool's URL for the environment the console is running in.
 *
 * `baseDomain` comes from configuration rather than being baked in, so a
 * non-production console does not hand operators links into production. There
 * is no fallback to `tesserix.app` on purpose: a missing value should surface
 * as a configuration error, not as a silent link to prod.
 */
export function toolUrl(tool: InternalTool, baseDomain: string): string {
  return `https://${tool.subdomain}.${baseDomain}`;
}

/** Tools in a group, in declaration order. */
export function toolsInGroup(group: ToolGroup): readonly InternalTool[] {
  return INTERNAL_TOOLS.filter((tool) => tool.group === group);
}
