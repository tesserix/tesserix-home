const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface PlatformDashboard {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { total: number; by_status: Record<LeadStatus, number> };
  apps: { active: number };
  generated_at: string;
}

/** Carries the HTTP status when there was one. A 501 means the endpoint is
 *  parked; anything else is a real failure. Losing the status here collapses
 *  that distinction and a parked plane starts reading as broken. */
export class PlatformApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformApiError";
    this.status = status;
  }
}

/** A rejection is not guaranteed to be an `Error` — an undefined `.message`
 *  would read as a mystery failure. Narrow before formatting. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`dashboard: ${path} is not a number`);
  }
  return value;
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new PlatformApiError(`dashboard: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

export function parseDashboard(json: unknown): PlatformDashboard {
  const root = obj(json, "response");
  const tenants = obj(root.tenants, "tenants");
  const stores = obj(root.stores, "stores");
  const leads = obj(root.leads, "leads");
  const apps = obj(root.apps, "apps");
  const byStatus = obj(leads.by_status, "leads.by_status");

  const buckets = {} as Record<LeadStatus, number>;
  for (const status of LEAD_STATUSES) {
    buckets[status] = num(byStatus[status], `leads.by_status.${status}`);
  }

  if (typeof root.generated_at !== "string") {
    throw new PlatformApiError("dashboard: generated_at is missing");
  }

  return {
    tenants: {
      total: num(tenants.total, "tenants.total"),
      active: num(tenants.active, "tenants.active"),
    },
    stores: { total: num(stores.total, "stores.total") },
    leads: { total: num(leads.total, "leads.total"), by_status: buckets },
    apps: { active: num(apps.active, "apps.active") },
    generated_at: root.generated_at,
  };
}

// Cluster-internal by default so dashboard reads never egress to the public
// internet. Overridden per environment; the localhost default is dev only.
const WEB_ORIGIN = process.env.WEB_INTERNAL_ORIGIN ?? "http://localhost:3002";

export async function fetchDashboard(
  cookieHeader: string,
): Promise<PlatformDashboard> {
  let response: Response;
  try {
    response = await fetch(`${WEB_ORIGIN}/api/admin/dashboard`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
  } catch (cause) {
    throw new PlatformApiError(
      `dashboard: request failed (${describe(cause)})`,
      undefined,
      { cause },
    );
  }

  if (!response.ok) {
    throw new PlatformApiError(
      `dashboard: responded ${response.status}`,
      response.status,
    );
  }

  // Inside the boundary too: an ok response carrying HTML (a proxy or ingress
  // error page) must surface as a PlatformApiError like every other failure
  // here, not as a raw SyntaxError. parseDashboard already throws
  // PlatformApiError itself, so it stays outside and keeps its own messages.
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PlatformApiError(
      `dashboard: response was not JSON (${describe(cause)})`,
      response.status,
      { cause },
    );
  }

  return parseDashboard(body);
}

/**
 * The cross-product ticket queue.
 *
 * Same shape as `fetchDashboard` deliberately — one failure type, one place
 * that decides what "the upstream misbehaved" looks like. The parser lives in
 * `lib/tickets.ts` so this file stays about transport.
 */
export async function fetchTickets(
  cookieHeader: string,
): Promise<import("./tickets").TicketsPage> {
  const { parseTickets } = await import("./tickets");

  let response: Response;
  try {
    response = await fetch(`${WEB_ORIGIN}/api/admin/platform-tickets`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
  } catch (cause) {
    throw new PlatformApiError(
      `tickets: request failed (${describe(cause)})`,
      undefined,
      { cause },
    );
  }

  if (!response.ok) {
    throw new PlatformApiError(
      `tickets: responded ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PlatformApiError(`tickets: response was not JSON`, undefined, {
      cause,
    });
  }
  return parseTickets(body);
}
