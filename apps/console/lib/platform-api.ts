import { PlatformApiError } from "./platform-api-error";

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

/**
 * Declared in `./platform-api-error` and re-exported here so the many existing
 * `from "@/lib/platform-api"` imports keep working. This is a re-export of the
 * SAME binding, not a copy — one class identity, so `instanceof` holds
 * everywhere.
 *
 * It was moved out because it is a value import, and a `"use client"` component
 * importing it from this module pulled this module — and through it
 * `auth/platform-token` -> `db/tesserix` -> `pg` — into the browser bundle. See
 * the header of `./platform-api-error`.
 */
export { PlatformApiError } from "./platform-api-error";

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
 * The platform API's origin, when the console is pointed at it.
 *
 * # Why this is a switch and not a replacement
 *
 * #269 migrates the four ticket call sites off `/api/admin/*`. Doing that as a
 * straight swap would break the deployed console the moment it shipped, for a
 * reason that has nothing to do with the module: the platform API takes a
 * Zitadel access token (ADR-003 D8) and this console does not have one yet —
 * `app/auth/callback/route.ts` keeps the ID token and discards the rest. See
 * `lib/auth/platform-token.ts`.
 *
 * So the client learns to speak both, and the environment decides. Unset — the
 * deployed state today — is byte-for-byte the current behaviour. Set, with a
 * token available, and tickets come from the Go module. Flipping it is then a
 * one-line environment change made when login and token retention are ready,
 * rather than a code change made under pressure.
 *
 * The alternative was to hold the migration on a branch until login is fixed.
 * That trades a reviewable switch for a long-lived branch that rots against a
 * moving console, which is the worse of the two.
 */
export function platformApiOrigin(): string | null {
  const origin = process.env.PLATFORM_API_ORIGIN?.trim();
  return origin ? origin.replace(/\/+$/, "") : null;
}

/**
 * Unwrap go-shared's StandardResponse.
 *
 * `{ success, data, error, meta }` — the estate's envelope, which the platform
 * API adopts field for field. A failure is turned into a `PlatformApiError`
 * carrying the API's own code and message, because those are the strings an
 * operator can act on: "no such ticket" and "you do not hold the capability
 * this action requires" say different things and the console renders them
 * differently.
 */
function unwrap(label: string, status: number, body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    throw new PlatformApiError(`${label}: response was not an object`, status);
  }
  const envelope = body as {
    success?: unknown;
    data?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (envelope.success === true) {
    return envelope.data;
  }
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "UNKNOWN";
  const message =
    typeof envelope.error?.message === "string" ? envelope.error.message : "request failed";
  throw new PlatformApiError(`${label}: ${code} — ${message}`, status);
}

/**
 * Call the platform API as the current operator.
 *
 * Throws when there is no token rather than sending the request unauthenticated:
 * a 401 with no body a human wrote is a worse answer than saying plainly that
 * this console cannot yet authenticate to that API.
 *
 * `cache: "no-store"` for the same reason every other read here sets it — an
 * operator acting on a queue must not be shown a cached one.
 */
async function platformRequest(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const origin = platformApiOrigin();
  if (!origin) {
    throw new PlatformApiError(`${label}: the platform API origin is not configured`);
  }
  const { getPlatformApiToken } = await import("./auth/platform-token");
  const token = await getPlatformApiToken();
  if (!token) {
    throw new PlatformApiError(
      `${label}: this session carries no platform API access token (ADR-003 D8)`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
    });
  } catch (cause) {
    throw new PlatformApiError(`${label}: request failed (${describe(cause)})`, undefined, {
      cause,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PlatformApiError(
      `${label}: response was not JSON (${describe(cause)})`,
      response.status,
      { cause },
    );
  }
  // Unwrapped even on a non-2xx: the envelope is the same shape either way, and
  // its `error.code` is more useful than the status alone.
  return unwrap(label, response.status, body);
}

/**
 * A fresh idempotency key for one write.
 *
 * Minted per attempt rather than per retry, which is the right way round: the
 * key identifies the REQUEST the operator made, so a genuine second reply gets
 * its own key and a transport-level retry of the same request reuses this one.
 * Server actions run once per submission, so this is that boundary.
 */
function idempotencyKey(): string {
  return crypto.randomUUID();
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
  if (platformApiOrigin()) {
    return fetchTicketsFromPlatformApi(filters);
  }

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

/**
 * The queue, composed from the platform API's two resources.
 *
 * **This function is #269's answer, and the whole reason the API refused to
 * serve `{summary, rows}` itself.** The listing and the standing count are two
 * different questions — one is a filtered page, the other is a property of the
 * queue — and welding them into one payload is what made the old endpoint
 * screen-shaped. The API serves domain resources; the composition belongs
 * wherever a screen is being drawn, which is here.
 *
 * `Promise.all`, not sequential: they are independent reads and a queue screen
 * should not pay two round trips in series. `Promise.all` and not `allSettled`
 * because both halves are required — a queue with no counts, or counts with no
 * queue, is a half-rendered screen and the surface's error state says more than
 * a blank panel does.
 *
 * The summary is deliberately NOT filtered. It cannot be: the API offers no way
 * to narrow it, which is what keeps the headline numbers still while an
 * operator narrows the list.
 */
async function fetchTicketsFromPlatformApi(
  filters: TicketFilters,
): Promise<import("./tickets").TicketsPage> {
  const { parseTicketList, parseTicketsSummary } = await import("./tickets");

  const query = new URLSearchParams(ticketsQuery(filters));
  // The page size the console asks for. Matches what apps/web served, so the
  // surface behaves as it does today; the difference is that this one is a
  // page with a cursor behind it rather than a silent cap.
  query.set("limit", "200");

  const [list, summary] = await Promise.all([
    platformRequest("tickets", `/v1/tickets?${query.toString()}`),
    platformRequest("tickets summary", "/v1/tickets/summary"),
  ]);

  return {
    summary: parseTicketsSummary(summary),
    rows: parseTicketList(list),
  };
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

  if (platformApiOrigin()) {
    // parseTicketDetail is used UNCHANGED against the module's payload — the
    // envelope is stripped by platformRequest and what is left is
    // `{ticket, replies}`, the shape this parser already reads. Verified
    // against the module's committed golden files.
    const data = await platformRequest("ticket", `/v1/tickets/${encodeURIComponent(id)}`);
    return parseTicketDetail(data);
  }

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
  if (platformApiOrigin()) {
    await platformRequest("ticket reply", `/v1/tickets/${encodeURIComponent(id)}/replies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Makes a retried submission land once. The API records the key in the
        // same transaction as the reply, so a key that exists always
        // corresponds to a reply that committed.
        "idempotency-key": idempotencyKey(),
      },
      body: JSON.stringify(input),
    });
    return;
  }

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
  if (platformApiOrigin()) {
    await platformRequest("ticket status", `/v1/tickets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey(),
      },
      body: JSON.stringify({ status }),
    });
    return;
  }

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
