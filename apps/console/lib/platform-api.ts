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

interface Envelope {
  data: unknown;
  meta: unknown;
}

/**
 * Unwrap go-shared's StandardResponse, keeping `meta`.
 *
 * `{ success, data, error, meta }` — the estate's envelope, which the platform
 * API adopts field for field. A failure is turned into a `PlatformApiError`
 * carrying the API's own code and message, because those are the strings an
 * operator can act on: "no such ticket" and "you do not hold the capability
 * this action requires" say different things and the console renders them
 * differently.
 *
 * `meta` was previously discarded because tickets did not need it: its summary
 * is a separate resource, per §2. The CRM queues put `total`, `preceding_count`
 * and both cursors there, and the console's pagination controls need all four —
 * so the envelope has to be opened once and handed over whole.
 */
function unwrapEnvelope(label: string, status: number, body: unknown): Envelope {
  if (typeof body !== "object" || body === null) {
    throw new PlatformApiError(`${label}: response was not an object`, status);
  }
  const envelope = body as {
    success?: unknown;
    data?: unknown;
    meta?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (envelope.success === true) {
    return { data: envelope.data, meta: envelope.meta };
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
async function platformCall(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<Envelope> {
  const origin = platformApiOrigin();
  if (!origin) {
    throw new PlatformApiError(`${label}: the platform API origin is not configured`);
  }
  const { resolvePlatformApiToken } = await import("./auth/platform-token");
  const { token, reauthRequired } = await resolvePlatformApiToken();
  if (!token) {
    // The marker is set ONLY for the absence a fresh sign-in mints a token for.
    // Marking every tokenless case would tell an operator to sign in again when
    // the encryption key is unset — where the callback's write fails the same
    // check the read did, so the new session lands on the identical prompt,
    // forever — or when tesserix-postgres is down, where it answers an outage
    // with a callout asserting nothing is broken. Both are this branch's own
    // failure mode in better clothes: the unactionable message replaced by a
    // confidently wrong one.
    throw new PlatformApiError(
      reauthRequired
        ? `${label}: this session carries no platform API access token (ADR-003 D8)`
        : `${label}: could not obtain a platform API access token for this session`,
      undefined,
      { noOperatorToken: reauthRequired },
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
  return unwrapEnvelope(label, response.status, body);
}

/**
 * Which of these two functions a caller needs depends entirely on where the
 * PRODUCER puts pagination — platform-api has two conventions, not one, and
 * guessing wrong is exactly how #421 shipped: `/kora/ai-metrics`'s fixture
 * and parser both assumed the `entities` shape for an endpoint that actually
 * uses the other one, so every test passed while production 500'd.
 *
 * | Module                                                     | Where pagination lives          | Read with |
 * |--------------------------------------------------------------|----------------------------------|-------------------------|
 * | `entities` (`service.go:137`, `json:"pagination"`)          | inside `data`, as `data.pagination` | `platformRequest`, then the parser reads `body.pagination` itself (see `parseEntities`) |
 * | `koraaimetrics` (`handler.go:86`, `httpx.WriteMeta`)        | in the envelope's `meta`, a sibling of `data` | `platformRequestWithMeta` (see `parseKoraAiMetricsPagination`) |
 *
 * Before adding a new paged read: check the Go producer's own response
 * construction (`WriteMeta` vs. a hand-built `data` object carrying its own
 * `pagination` field) rather than pattern-matching an existing console
 * caller — `/kora/ai-metrics` was written by pattern-matching its working
 * siblings `/kora/foods` and `/kora/users`, which use the first convention,
 * and its producer used the second. `lib/test-support/pagination-envelope.ts`
 * has fixture builders for both shapes, named so a test has to choose one on
 * purpose.
 */
async function platformRequest(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  return (await platformCall(label, path, init)).data;
}

/** As `platformRequest`, but keeps `meta` — see the table on `platformRequest`
 *  for which producers need this instead. */
export async function platformRequestWithMeta(
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<{ data: unknown; meta: unknown }> {
  return platformCall(label, path, init);
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
 * once. **One request, not three, on either transport** — the fan-out lives
 * behind the endpoint, and so do the partial-failure semantics. The point of
 * this function is that the two transports answer the same way, because
 * unsetting `PLATFORM_API_ORIGIN` has to be a true rollback:
 *
 * - **200 with a populated `failures` array** when some sources answered and
 *   others did not. Both paths.
 * - **501** when the surface is not instrumented at all: apps/web returns it
 *   when every source is unconfigured, and the platform API returns it when
 *   `FEDERATION_PRODUCTS` names no product. Both paths.
 * - A source the endpoint does not know is visible rather than an empty
 *   timeline on both paths, but the two do not agree on the status: the
 *   platform API answers **400** naming the bad `source`, while apps/web's
 *   aggregate endpoint answers **404** `unsupported_product`. Both are
 *   refusals a typo'd filter cannot mistake for zero rows, which is the
 *   property this surface relies on — the exact code is not.
 * - **502** when every source genuinely failed — apps/web only. The platform
 *   API expresses that as a 200 whose `failures` covers every source, which
 *   the surface renders identically: rows it has beside the sources it lost.
 *
 * Both paths are asked for the same `limit` and `since_hours`, so the two
 * transports cover the same window. Unbounded, the platform API asks each
 * product for its entire audit log and truncates the answer at 1 MiB.
 *
 * `request` and `platformRequest` both throw on any non-2xx, so a 501 arrives
 * here as a `PlatformApiError` carrying `status: 501` — which `resolveState`
 * maps to `instrumentation-unavailable` rather than to an error an operator
 * would try to retry. That mapping is the reason the status is kept rather
 * than flattened into a message.
 */
export async function fetchEstateAuditLog(
  cookieHeader: string,
  product: string,
): Promise<import("./audit").EstateAuditLog> {
  const { parseEstateAuditLog } = await import("./audit");

  // The same bounds on both transports, because the promise of the cutover is
  // that the two answer the same question. Sent rather than left to the API's
  // defaults so the window is stated by the caller that renders it.
  const bounds = {
    limit: String(AUDIT_LIMIT),
    since_hours: String(AUDIT_SINCE_HOURS),
  };

  if (platformApiOrigin()) {
    const query = new URLSearchParams(bounds);
    // `all` is the absence of a filter, not a source. Sending `source=all`
    // would ask the API for a product it has never heard of, and it refuses
    // an unknown source with a 400 rather than returning nothing — which is
    // the behaviour that makes a typo visible instead of silent.
    if (product !== "all") query.set("source", product);
    return parseEstateAuditLog(
      await platformRequest("audit log", `/v1/audit?${query.toString()}`),
    );
  }

  const query = new URLSearchParams(bounds);
  const response = await request(
    "audit log",
    `/api/admin/apps/${encodeURIComponent(product)}/audit-logs?${query.toString()}`,
    { headers: { cookie: cookieHeader } },
  );
  return parseEstateAuditLog(await readBody(response, "audit log"));
}

/** Rows asked of each product. The platform API defaults to 100; stated here
 * so the window is set by the caller that renders it. */
const TENANTS_LIMIT = 100;

/**
 * Every product's tenants, aggregated.
 *
 * **One transport, deliberately — no apps/web fallback**, unlike
 * `fetchEstateAuditLog` above.
 *
 * That asymmetry is the point rather than an omission. The audit surface HAS
 * an apps/web predecessor serving the same question, so unsetting
 * `PLATFORM_API_ORIGIN` is a true rollback. This surface does not: apps/web's
 * `/admin/tenants` reads and WRITES mark8ly's tenants table directly over the
 * cross-database grant (#210), bypassing validation, domain events, cache
 * invalidation and mark8ly's own audit row. Falling back to it would not be a
 * rollback — it would be a return to the write path this replaces.
 *
 * So with no origin configured, this surface is unavailable, and says so.
 *
 * `platformRequest` throws on any non-2xx, so a 501 arrives as a
 * `PlatformApiError` carrying `status: 501` — which the page maps to
 * "not instrumented" rather than to an error worth retrying. That is why the
 * status is kept rather than flattened into a message: an unconfigured estate
 * and an empty one are different claims, and only one of them is actionable.
 */
export async function fetchEstateTenants(
  filters: { product?: string; q?: string; status?: string } = {},
): Promise<import("./tenants").EstateTenants> {
  const { parseEstateTenants } = await import("./tenants");

  if (!platformApiOrigin()) {
    throw new PlatformApiError(
      "tenants: PLATFORM_API_ORIGIN is not set, and this surface has no apps/web predecessor to fall back to",
      501,
    );
  }

  const query = new URLSearchParams({ limit: String(TENANTS_LIMIT) });
  // `all` is the absence of a filter, not a source. Sending `source=all` would
  // ask the API for a product it has never heard of, and it refuses an unknown
  // source with a 400 rather than returning nothing — the behaviour that makes
  // a typo visible instead of silent.
  if (filters.product && filters.product !== "all") query.set("source", filters.product);
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);

  return parseEstateTenants(
    await platformRequest("tenants", `/v1/tenants?${query.toString()}`),
  );
}

/**
 * One product's lifecycle reason codes, from contract §8.8.
 *
 * Fetched per product and never merged, because the vocabularies are
 * per-product and deliberately unequal — mark8ly declares seven suspend codes
 * and four different unsuspend ones. A merged menu could offer a code the
 * owning product refuses, or one both accept and mean differently, and the
 * second lands a wrong reason on an audit row silently. The platform API
 * refuses a request without `source` for exactly this reason.
 *
 * No apps/web fallback: that app never served this, and its `/admin/tenants`
 * predecessor is gone (#210).
 */
export async function fetchLifecycleReasonCodes(
  product: string,
): Promise<import("./tenant-lifecycle").ProductReasonCodes> {
  const { parseReasonCodes } = await import("./tenant-lifecycle");

  if (!platformApiOrigin()) {
    throw new PlatformApiError(
      "reason codes: PLATFORM_API_ORIGIN is not set",
      501,
    );
  }

  const query = new URLSearchParams({ source: product });
  return parseReasonCodes(
    await platformRequest(
      "tenants",
      `/v1/tenants/lifecycle/reason-codes?${query.toString()}`,
    ),
  );
}

/** The page size the billing surfaces ask each product for. */
export const BILLING_LIMIT = 100;

/**
 * The estate's recurring plans — contract §8.2.
 *
 * Gated on the `billing` capability at the platform API, not `platform`. A
 * `403` here therefore means the operator holds platform but not billing,
 * which is a real and intended outcome rather than a bug.
 */
export async function fetchEstateSubscriptions(): Promise<
  import("./billing").SubscriptionPage
> {
  const { parseSubscriptions } = await import("./billing");
  const query = new URLSearchParams({ limit: String(BILLING_LIMIT) });
  return parseSubscriptions(
    await platformRequest("subscriptions", `/v1/billing/subscriptions?${query.toString()}`),
  );
}

/**
 * The estate's expiring trials — contract §8.2.
 *
 * Stripe-managed trials are excluded by default on the product side and this
 * does not opt them back in: they are not the rows anyone acts on, and §8.2's
 * question is "which trials expire this week, with dunning state".
 */
export async function fetchEstateTrials(): Promise<import("./billing").TrialPage> {
  const { parseTrials } = await import("./billing");
  const query = new URLSearchParams({ limit: String(BILLING_LIMIT) });
  return parseTrials(
    await platformRequest("trials", `/v1/billing/trials?${query.toString()}`),
  );
}

/**
 * The page size the product-rail index pages ask for.
 *
 * 50, not 100: these surfaces page now, and a shorter page is a faster first
 * paint and less to scan before deciding to search. The number is stated here
 * rather than transcribed into page copy, so it cannot go stale in two places.
 */
export const ENTITIES_LIMIT = 50;

/**
 * One product's §3.4 entity records — `foods`, `users`.
 *
 * `source` and `type` are both required by the API: an entity type is one
 * product's records, and merging two products' `users` makes a table whose
 * columns mean different things per row (§8.5).
 *
 * An absent `q` is a BROWSE, which is the contract's shape since §3.4 was
 * clarified (tesserix/kora#473). It is omitted rather than sent blank — `q=`
 * would filter on the empty string on a product that treats the param as
 * present.
 *
 * `limit` defaults to `ENTITIES_LIMIT` — the product-rail index pages' page
 * size — but a caller that only wants `pagination.total` (the `/kora`
 * overview's Foods/Users tiles) may pass `1`: the total is the product's own
 * count regardless of how many rows were asked for, so there is no reason to
 * fetch fifty rows just to discard them.
 */
export async function fetchProductEntities(
  source: string,
  type: string,
  search?: string,
  page = 1,
  limit = ENTITIES_LIMIT,
): Promise<import("./entities").EntityPage> {
  const { parseEntities } = await import("./entities");

  const query = new URLSearchParams({ source, limit: String(limit) });
  if (search) query.set("q", search);
  // Omitted at 1: the platform API defaults to the first page, and sending it
  // makes every first-page request differ from the default for no gain.
  if (page > 1) query.set("page", String(page));

  return parseEntities(
    await platformRequest(
      "entities",
      `/v1/entities/${encodeURIComponent(type)}?${query.toString()}`,
    ),
  );
}

/** The bound this surface asks each product for. Sent rather than left to the
 *  API's default so the window is stated by the caller that renders it. */
export const INBOX_LIMIT = 100;

/**
 * The estate inbox — contract §3.2, federated by the platform API's `inbox`
 * module across every product declaring it.
 *
 * No apps/web fallback: that app never served an estate-wide queue. An unset
 * `PLATFORM_API_ORIGIN` is a misconfiguration, and `platformRequest` says so.
 *
 * A `501` here means no product declares §3.2 — which is NOT the same as an
 * empty queue, and the page must render the two differently. An empty queue is
 * a real and reassuring answer; instrumentation that was never wired must not
 * be able to produce that reassurance.
 */
export async function fetchEstateInbox(
  source?: string,
): Promise<import("./inbox").EstateInbox> {
  const { parseInbox } = await import("./inbox");

  const query = new URLSearchParams({ limit: String(INBOX_LIMIT) });
  // `all` is the absence of a filter, not a source. Sending `source=all` would
  // ask the API for a product it has never heard of, and it refuses an unknown
  // source with a 400 rather than returning nothing — the behaviour that makes
  // a typo visible instead of silent.
  if (source && source !== "all") query.set("source", source);

  return parseInbox(await platformRequest("inbox", `/v1/inbox?${query.toString()}`));
}

/**
 * Kora's food-resolution accuracy metrics — platform-api's one named
 * federated route for a product's own endpoint (`koraaimetrics.go`'s doc
 * comment explains why this is a named route rather than a generic
 * passthrough).
 *
 * No window or paging parameters are sent: the `/kora` overview's AI
 * resolution tile shows the metrics as Kora's default window answers them,
 * not a caller-chosen range — there is no picker on this surface to drive one.
 *
 * A `501` here means this deployment does not federate Kora at all
 * (`FEDERATION_PRODUCTS` omits it) — a deployment fact, not something Kora
 * said, and NOT the same as Kora measuring nothing. `platformRequest` says
 * so via the same 501 contract every other federated read here uses.
 */
export async function fetchKoraAiMetrics(): Promise<import("./kora-ai-metrics").KoraAiMetrics> {
  const { parseKoraAiMetrics } = await import("./kora-ai-metrics");
  return parseKoraAiMetrics(await platformRequest("kora ai metrics", "/v1/kora/ai-metrics"));
}

/**
 * The full `/kora/ai-metrics` surface's read — the SAME endpoint
 * `fetchKoraAiMetrics` calls, paged for the per-user table it adds. One HTTP
 * call, decoded twice by two small functions in `kora-ai-metrics.ts` rather
 * than two separate reads: `window`/`outcomes`/`users` live in the envelope's
 * `data`, and pagination (`total`/`limit`) lives in its `meta` — which is why
 * this uses `platformRequestWithMeta`, not `platformRequest`; the latter
 * discards `meta` before either parser would see it.
 *
 * `page` only — no `from`/`to`. The endpoint accepts a caller-chosen window,
 * but this surface states Kora's default window rather than offering a
 * picker; see the page's own doc comment for why. Also passed straight
 * through to `parseKoraAiMetricsPagination`: `meta` never carries a `page`
 * field (see that function's doc comment), so this is the only place it
 * comes from.
 */
export async function fetchKoraAiMetricsPage(page = 1): Promise<{
  metrics: import("./kora-ai-metrics").KoraAiMetrics;
  pagination: import("./entities").EntityPagination;
}> {
  const { parseKoraAiMetrics, parseKoraAiMetricsPagination } = await import(
    "./kora-ai-metrics"
  );

  const query = new URLSearchParams();
  // Omitted at 1, matching `fetchProductEntities`: the platform API defaults
  // to the first page, and sending it makes every first-page request differ
  // from the default for no gain.
  if (page > 1) query.set("page", String(page));
  const path = query.toString()
    ? `/v1/kora/ai-metrics?${query.toString()}`
    : "/v1/kora/ai-metrics";

  const { data, meta } = await platformRequestWithMeta("kora ai metrics", path);
  return {
    metrics: parseKoraAiMetrics(data),
    pagination: parseKoraAiMetricsPagination(meta, page),
  };
}

/**
 * The AI cost and token usage ledger, from the platform API's `aiusage` module.
 *
 * Server-side only, and deliberately: the console holds the operator's Zitadel
 * token and the gateway's telemetry is not a browser-reachable surface. The
 * page's tabs each read one of these rather than one composite endpoint, so a
 * reader who never opens the events tail never pays for it.
 *
 * No apps/web fallback, unlike `fetchTickets`. This surface has no predecessor
 * there — the AI gateway postdates that app — so an unset `PLATFORM_API_ORIGIN`
 * is a misconfiguration, and `platformRequest` says so.
 */
export interface AiUsageQuery {
  readonly window?: string;
  readonly product?: string;
  readonly provider?: string;
}

function aiUsageParams(query: AiUsageQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    // Blank means "no filter". Sent, it would filter on the empty string, and
    // the platform API refuses parameters it does not read rather than
    // ignoring them (#307) — so a stray key is a 400, not a wrong answer.
    if (value) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export async function fetchAiUsageSummary(
  query: AiUsageQuery = {},
): Promise<import("./ai-usage").AiUsageSummary> {
  const { parseAiUsageSummary } = await import("./ai-usage");
  return parseAiUsageSummary(
    await platformRequest("ai usage summary", `/v1/ai/usage/summary${aiUsageParams(query)}`),
  );
}

export async function fetchAiUsageBreakdown(
  by: string,
  query: AiUsageQuery = {},
): Promise<import("./ai-usage").AiUsageBreakdown> {
  const { parseAiUsageBreakdown } = await import("./ai-usage");
  return parseAiUsageBreakdown(
    await platformRequest(
      "ai usage breakdown",
      `/v1/ai/usage/breakdown${aiUsageParams(query, { by })}`,
    ),
  );
}

export async function fetchAiUsageGuardrails(
  query: AiUsageQuery = {},
): Promise<import("./ai-usage").AiUsageGuardrails> {
  const { parseAiUsageGuardrails } = await import("./ai-usage");
  return parseAiUsageGuardrails(
    await platformRequest("ai guardrails", `/v1/ai/usage/guardrails${aiUsageParams(query)}`),
  );
}

export const AI_EVENTS_LIMIT = 50;

export async function fetchAiUsageEvents(
  query: AiUsageQuery = {},
  outcome?: string,
): Promise<import("./ai-usage").AiUsageEvents> {
  const { parseAiUsageEvents } = await import("./ai-usage");
  const extra: Record<string, string> = { limit: String(AI_EVENTS_LIMIT) };
  if (outcome) extra.outcome = outcome;
  return parseAiUsageEvents(
    await platformRequest("ai usage events", `/v1/ai/usage/events${aiUsageParams(query, extra)}`),
  );
}
