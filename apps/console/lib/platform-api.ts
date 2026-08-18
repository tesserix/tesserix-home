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
 * Narrowing applied to the queue. Every key is optional; an omitted key means
 * "no filter", which is why a blank value is dropped rather than sent — web
 * reads `?status=` as the empty string and would filter on it.
 *
 * The names are apps/web's query params verbatim (`product`, not `productId`),
 * so there is no translation table to keep in step.
 */
export interface TicketFilters {
  readonly status?: string;
  readonly priority?: string;
  readonly product?: string;
}

export function ticketsQuery(filters: TicketFilters): string {
  const params = new URLSearchParams();
  for (const key of ["status", "priority", "product"] as const) {
    const value = filters[key];
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

/**
 * The cross-product ticket queue.
 *
 * Same shape as `fetchDashboard` deliberately — one failure type, one place
 * that decides what "the upstream misbehaved" looks like. The parser lives in
 * `lib/tickets.ts` so this file stays about transport.
 *
 * Filtering happens upstream, in SQL (`listPlatformTickets`), not here: the
 * queue is capped at 200 rows, so filtering the fetched page would narrow the
 * wrong set — the first 200 unfiltered tickets rather than the first 200
 * matching ones.
 */
export async function fetchTickets(
  cookieHeader: string,
  filters: TicketFilters = {},
): Promise<import("./tickets").TicketsPage> {
  const { parseTickets } = await import("./tickets");

  const query = ticketsQuery(filters);
  let response: Response;
  try {
    response = await fetch(
      `${WEB_ORIGIN}/api/admin/platform-tickets${query ? `?${query}` : ""}`,
      {
        headers: { cookie: cookieHeader },
        cache: "no-store",
      },
    );
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

// The origin apps/web's CSRF gate checks writes against. A server-to-server
// fetch carries no Origin of its own, and evaluateCsrf treats "cookie-bearing
// mutation, no Origin" as a forgery — so the console names itself explicitly.
// Must stay in lockstep with DEFAULT_CSRF_HOSTNAMES in @tesserix/platform-auth
// (plus any CSRF_ALLOWED_DOMAINS the company deployment adds on top).
const CONSOLE_ORIGIN =
  process.env.CONSOLE_PUBLIC_ORIGIN ?? "https://console.tesserix.app";

async function readBody(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: response was not JSON (${describe(cause)})`,
      response.status,
      { cause },
    );
  }
}

async function request(
  label: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${WEB_ORIGIN}${path}`, { cache: "no-store", ...init });
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: request failed (${describe(cause)})`,
      undefined,
      { cause },
    );
  }
  if (!response.ok) {
    throw new PlatformApiError(
      `${label}: responded ${response.status}`,
      response.status,
    );
  }
  return response;
}

export async function fetchTicketDetail(
  id: string,
  cookieHeader: string,
): Promise<import("./tickets").TicketDetail> {
  const { parseTicketDetail } = await import("./tickets");
  const response = await request(
    "ticket",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}`,
    { headers: { cookie: cookieHeader } },
  );
  return parseTicketDetail(await readBody(response, "ticket"));
}

export async function postTicketReply(
  id: string,
  input: { content: string; newStatus?: import("./tickets").TicketStatus },
  cookieHeader: string,
): Promise<void> {
  await request(
    "ticket reply",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}/replies`,
    {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        origin: CONSOLE_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function patchTicketStatus(
  id: string,
  status: import("./tickets").TicketStatus,
  cookieHeader: string,
): Promise<void> {
  await request(
    "ticket status",
    `/api/admin/platform-tickets/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        cookie: cookieHeader,
        origin: CONSOLE_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status }),
    },
  );
}

/**
 * Platform-wide support analytics.
 *
 * Read through apps/web like everything else on this surface, and for a reason
 * beyond consistency: that route enriches otto's raw tenant ids with names from
 * the mark8ly database, which the console cannot reach. Talking to otto
 * directly would trade a column of store names for a column of UUIDs.
 */
export async function fetchSupportAnalytics(
  cookieHeader: string,
): Promise<import("./support-analytics").SupportAnalytics> {
  const { parseSupportAnalytics } = await import("./support-analytics");
  const response = await request("support analytics", "/api/admin/analytics/support", {
    headers: { cookie: cookieHeader },
  });
  return parseSupportAnalytics(await readBody(response, "support analytics"));
}

/**
 * How far back the products' audit trails are asked to reach, in hours.
 *
 * 720 is the endpoint's own maximum (`MAX_SINCE_HOURS`), taken deliberately so
 * the LIMIT, not the window, is what truncates the timeline. A short window
 * would silently hide a quiet product's most recent event behind an arbitrary
 * cutoff, and a merged timeline missing a source's newest row is the failure
 * mode this whole surface exists to avoid.
 *
 * It is still a cap, and an honest one: the surface says so on the page rather
 * than implying it shows everything ever recorded.
 */
export const AUDIT_SINCE_HOURS = 720;

/** Rows requested from the products' aggregate. Matches the endpoint's own
 *  default; the console's own log is read with the same limit. */
export const AUDIT_LIMIT = 200;

/**
 * Every product's audit trail, aggregated.
 *
 * `product` is a product id or `"all"`, which fans out across every source at
 * once. **One request, not three** — the fan-out lives behind the endpoint,
 * which is also where the partial-failure semantics live: 200 with a populated
 * `failures` array when some sources answered, 501 when every source is
 * unconfigured, 502 when every source genuinely failed.
 *
 * `request` throws on any non-2xx, so a 501 arrives here as a
 * `PlatformApiError` carrying `status: 501` — which `resolveState` maps to
 * `instrumentation-unavailable` rather than to an error an operator would try
 * to retry. That mapping is the reason the status is kept rather than
 * flattened into a message.
 */
export async function fetchEstateAuditLog(
  cookieHeader: string,
  product: string,
): Promise<import("./audit").EstateAuditLog> {
  const { parseEstateAuditLog } = await import("./audit");
  const query = new URLSearchParams({
    limit: String(AUDIT_LIMIT),
    since_hours: String(AUDIT_SINCE_HOURS),
  });
  const response = await request(
    "audit log",
    `/api/admin/apps/${encodeURIComponent(product)}/audit-logs?${query.toString()}`,
    { headers: { cookie: cookieHeader } },
  );
  return parseEstateAuditLog(await readBody(response, "audit log"));
}
