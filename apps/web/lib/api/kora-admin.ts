// Server-side signed client for kora-api's /v1/admin/* endpoints.
//
// tesserix-home is a trusted BFF signer for kora-api, exactly as it already is
// for homechef-api (lib/api/homechef-admin.ts). It signs each request itself
// and calls kora-api directly in-cluster, so every admin read flows through
// kora's own API — the portal has NO database access to Kora, which is the
// central decision of the food-data admin design.
//
// Wire format (must match kora api/internal/bffauth/bffauth.go:Compute exactly
// — drift = 401). Identity is BOUND INTO the MAC so kora cannot be handed a
// swapped X-User-Role with a still-valid signature:
//   X-Internal-Auth = HMAC_SHA256(
//     "${method}\n${path}\n${sha256hex(body)}\n${ts}\n${userId}\n${email}\n${role}\n${pool}", key )
//   + X-User-Id, X-User-Email, X-User-Role, X-Auth-Pool, X-Auth-Ts
// where `path` is kora's r.URL.Path (query string EXCLUDED) and `key` is the
// base64-decoded shared secret (kora reads the same GCP secret as
// KORA_BFF_HMAC_KEY).
import crypto from "node:crypto";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

// Trailing slash stripped: `KORA_API_URL` + `path` is plain concatenation
// below, and Node's URL parser does not collapse "http://host//v1/admin" —
// Gin's router won't match it either. That 404s BEFORE kora's bffauth
// middleware runs, so there is no signature evidence anywhere to diagnose
// from (see task-5-report.md, Minor 3).
const API_URL = (process.env.KORA_API_URL ?? "").replace(/\/+$/, "");
const HMAC_KEY_B64 = process.env.KORA_BFF_HMAC_KEY ?? "";

// Live testing of this slice's infra established the failure mode when the
// NetworkPolicy that allows tesserix-home -> kora-api is not yet in place:
// the connection HANGS (TCP retries) rather than being refused, and without
// a client-side timeout Node eventually gives up on its own after ~2 minutes.
// This page is a server component, so that hang blocks the render — a user
// sees what looks like a frozen page, the worst of the available failure
// modes, and the one most likely to occur (it happens whenever the three
// repos in this slice land in the wrong deploy order). 10s matches the
// UPSTREAM_TIMEOUT_MS convention already used by the otto proxy routes
// (app/api/otto/[...path]/route.ts, app/api/admin/otto/[...path]/route.ts):
// generous enough to absorb a Knative cold start for kora-api's pod (scale-
// to-zero) and ordinary in-cluster latency, but it fails fast — nowhere near
// the ~2 minute hang, and comfortably under Istio's 30s perTryTimeout so it
// resolves before the mesh's own retry budget would kick in.
const UPSTREAM_TIMEOUT_MS = 10_000; // abort the upstream fetch after 10s

/**
 * Every Kora admin endpoint lives under this prefix. NOTE: kora-api mounts its
 * routes under /v1, NOT /api/v1 like HomeChef. A mismatch here is a 404 that
 * reads like a routing bug.
 */
export const ADMIN_PREFIX = "/v1/admin";

export class KoraAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "KoraAdminError";
  }
}

/** Kora's error envelope (internal/httpx.Error / errorBody): `{"error": code, "message": msg}`. */
interface KoraErrorBody {
  error: string;
  message?: string;
}

/**
 * Kora's middleware deliberately distinguishes 401 (bad signature/clock/key),
 * 403 (correctly signed but not an admin identity), and 400 (unreadable body)
 * — see api/internal/bffauth/bffauth.go's comments. Without surfacing `error`/
 * `message` here, every one of those collapses into the same blanket failure
 * on this side, and whoever is paged has no way to tell a signature problem
 * from an authorization problem from a clock problem. Only returns a value
 * for bodies that actually match Kora's envelope — never fabricates a code.
 */
function extractKoraError(data: unknown): KoraErrorBody | undefined {
  if (!data || typeof data !== "object") return undefined;
  const body = data as { error?: unknown; message?: unknown };
  if (typeof body.error !== "string") return undefined;
  return {
    error: body.error,
    message: typeof body.message === "string" ? body.message : undefined,
  };
}

/** Identity fields bound into the signature (must match Go's `bffauth.Identity`). */
export interface SignedIdentity {
  userId: string;
  email: string;
  role: string;
  pool: string;
}

/**
 * Mirrors `Compute()` in kora's api/internal/bffauth/bffauth.go exactly. Pure
 * and exported so the unit test can pin it to a fixed vector that the Go test
 * pins to the same constant.
 */
export function computeSignature(
  method: string,
  path: string,
  body: Buffer,
  ts: string,
  key: Buffer,
  id: SignedIdentity,
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const mac = crypto.createHmac("sha256", key);
  mac.update(
    `${method}\n${path}\n${bodyHash}\n${ts}\n${id.userId}\n${id.email}\n${id.role}\n${id.pool}`,
  );
  return mac.digest("hex");
}

export interface AdminActor {
  userId: string;
  email: string;
}

/**
 * Builds the full signed header set. The acting admin's id/email are carried so
 * kora can attribute the action (slice 2 writes them to kora_admin_events);
 * role/pool are pinned to admin/internal, and kora's middleware rejects
 * anything else with a 403. Pure (takes `now` and the key) so it is testable.
 */
export function buildSignedHeaders(
  method: string,
  path: string,
  body: Buffer,
  actor: AdminActor,
  keyBase64: string,
  now: number,
): Record<string, string> {
  const key = Buffer.from(keyBase64, "base64");
  // Seconds. Go parses this with strconv.ParseInt and compares against Unix
  // seconds; milliseconds would land far outside the freshness window.
  const ts = Math.floor(now / 1000).toString();
  const id: SignedIdentity = {
    userId: actor.userId,
    email: actor.email,
    role: "admin",
    pool: "internal",
  };
  return {
    "Content-Type": "application/json",
    "X-User-Id": id.userId,
    "X-User-Email": id.email,
    "X-User-Role": id.role,
    "X-Auth-Pool": id.pool,
    "X-Auth-Ts": ts,
    "X-Internal-Auth": computeSignature(method, path, body, ts, key, id),
  };
}

export type AdminMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: unknown;
  search?: URLSearchParams | Record<string, string>;
}

export interface AdminResponse<T> {
  status: number;
  data: T;
}

function toQuery(search: RequestOptions["search"]): string {
  if (!search) return "";
  const qs =
    search instanceof URLSearchParams
      ? search.toString()
      : new URLSearchParams(
          Object.fromEntries(Object.entries(search).filter(([, v]) => v !== "")),
        ).toString();
  return qs ? `?${qs}` : "";
}

/**
 * Call a Kora admin endpoint, signed as a trusted BFF.
 * @param adminPath path UNDER /v1/admin, e.g. "/foods". MUST already be a
 * valid, pre-encoded path segment. `adminPath` is signed as the raw string
 * (see `computeSignature`) but `fetch` percent-encodes the URL on the wire,
 * so the two can diverge: a literal `%` in a segment makes Go reject the
 * request with 400 before it reaches gin, and a pre-encoded `%2F` is signed
 * literally while Go's router decodes it to `/`, giving a 401. Harmless today
 * (the only caller is the constant "/foods"), but the first path parameter
 * this function gains will need real encoding handled by the caller, not
 * assumed away here.
 */
export async function koraAdmin<T = unknown>(
  method: AdminMethod,
  adminPath: string,
  opts: RequestOptions = {},
): Promise<AdminResponse<T>> {
  if (!API_URL || !HMAC_KEY_B64) {
    throw new KoraAdminError(
      500,
      "not_configured",
      "KORA_API_URL / KORA_BFF_HMAC_KEY are not set",
    );
  }
  const session = await getCurrentSession();
  if (!session) throw new KoraAdminError(401, "no_session");

  const path = `${ADMIN_PREFIX}${adminPath.startsWith("/") ? adminPath : `/${adminPath}`}`;
  const bodyBytes =
    opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0);
  // Signed over `path` only — the query string is deliberately excluded, to
  // match Go's r.URL.Path.
  const headers = buildSignedHeaders(
    method,
    path,
    bodyBytes,
    { userId: session.sub, email: session.email },
    HMAC_KEY_B64,
    Date.now(),
  );
  const url = `${API_URL}${path}${toQuery(opts.search)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyBytes.length ? bodyBytes : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
    // (verified against this repo's Node/undici version) — distinguish it
    // from a hard connection failure so a timed-out request never collapses
    // into the same generic "upstream_unreachable" as a refused connection,
    // and never surfaces as an empty index.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      logger.error(`[kora-admin] upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms`, err);
      throw new KoraAdminError(504, "upstream_timeout", `kora-api did not respond within ${UPSTREAM_TIMEOUT_MS}ms`);
    }
    logger.error("[kora-admin] upstream unreachable", err);
    throw new KoraAdminError(502, "upstream_unreachable");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const koraError = extractKoraError(data);
    logger.warn(
      koraError
        ? `[kora-admin] ${method} ${path} -> ${res.status} ${koraError.error}${
            koraError.message ? `: ${koraError.message}` : ""
          }`
        : `[kora-admin] ${method} ${path} -> ${res.status}`,
    );
  }
  return { status: res.status, data: data as T };
}

/** One food row as kora's nutrition.FoodItem serialises it. */
export interface KoraFood {
  id: string;
  name: string;
  brand: string;
  provenance: string;
  barcode?: string;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  created_at: string;
}

export interface KoraFoodPage {
  items: KoraFood[];
  total: number;
}

/**
 * Narrow runtime check that a value actually has KoraFoodPage's shape. `res.data.data`
 * below is only a TypeScript-level assertion (`koraAdmin<{ data: KoraFoodPage }>`) — it
 * does not verify anything at runtime. A 200 with an unexpected body (kora-api's route
 * shape drifts, a proxy swallows the response, a misconfigured mock in a test) would
 * otherwise return `undefined` TYPED as `KoraFoodPage`, and every caller would render
 * that as a genuinely empty food index rather than as the failure it is. Deliberately
 * narrow: only checks the two fields callers actually rely on (`items` as an array,
 * `total` as a number), not every field of every `KoraFood`.
 */
function isKoraFoodPage(value: unknown): value is KoraFoodPage {
  if (!value || typeof value !== "object") return false;
  const page = value as { items?: unknown; total?: unknown };
  return Array.isArray(page.items) && typeof page.total === "number";
}

export async function listKoraFoods(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<KoraFoodPage> {
  const res = await koraAdmin<{ data: KoraFoodPage }>("GET", "/foods", {
    search: {
      q: params.q ?? "",
      limit: params.limit ? String(params.limit) : "",
      offset: params.offset ? String(params.offset) : "",
    },
  });
  if (res.status !== 200) {
    // Carry Kora's own diagnostic (see extractKoraError) rather than a bare
    // code, so a 401/403/400 stay distinguishable this far up the stack.
    const koraError = extractKoraError(res.data as unknown);
    throw new KoraAdminError(res.status, koraError?.error ?? "list_foods_failed", koraError?.message);
  }
  // kora wraps every response in {"data": ...} (internal/httpx.OK).
  const page = res.data?.data;
  if (!isKoraFoodPage(page)) {
    logger.warn(`[kora-admin] GET /foods -> 200 with an unexpected body shape`);
    throw new KoraAdminError(200, "unexpected_response_shape", "food index response did not match the expected shape");
  }
  return page;
}

// ---------------------------------------------------------------------------
// Slice 2: food detail, mutations, and the audit trail.
// ---------------------------------------------------------------------------

/**
 * One food as kora's `admin.FoodSnapshot` serialises it — the shape EVERY
 * mutation returns and the detail endpoint carries.
 *
 * This is deliberately a different type from `KoraFood` above rather than an
 * extension of it. `KoraFood` mirrors `nutrition.FoodItem`, which has no
 * `updated_at` and no `deleted_at`: kora returns that shape from the food
 * INDEX and this shape from everything else. Collapsing the two would mean
 * either pretending index rows carry `updated_at` (they do not — the edit
 * form would send `undefined` as its concurrency precondition and every PATCH
 * would 400) or making the fields optional everywhere, which pushes the same
 * problem into every call site.
 */
export interface KoraFoodSnapshot {
  id: string;
  name: string;
  brand: string;
  normalized_name: string;
  provenance: string;
  barcode?: string;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  has_embedding: boolean;
  created_at: string;
  updated_at: string;
  /** Present only on a retired food. Its presence IS the retirement. */
  deleted_at?: string;
}

/** `admin.FoodDetail` — the food plus how many logs reference it. */
export interface KoraFoodDetail {
  food: KoraFoodSnapshot;
  log_count: number;
}

/** The editable fields. Mirrors kora's `admin.foodPayload` exactly. */
export interface KoraFoodInput {
  name: string;
  brand: string;
  provenance?: string;
  barcode?: string | null;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
}

/**
 * What a mutation returns. `cacheBumpFailed` carries kora's
 * `meta.cache_bump_failed` (rider 4): the mutation COMMITTED, but the resolve
 * cache could not be invalidated, so users may be served the old macros for
 * up to 24h. It is not a failure and must never be rendered as one — but it
 * is not nothing either, so it is surfaced rather than dropped.
 */
export interface KoraMutationResult {
  food: KoraFoodSnapshot;
  cacheBumpFailed: boolean;
}

/**
 * Narrow runtime check for a food snapshot. Same reasoning as
 * `isKoraFoodPage`: `res.data.data` is a TypeScript-level assertion that
 * verifies nothing at runtime, so an unexpected 200 body would otherwise
 * hand every caller `undefined` TYPED as a food — and an edit form would
 * render blank fields over a real row, then submit them.
 *
 * Checks `updated_at` specifically, not just `id`: it is the field the edit
 * form depends on, and a response missing it is unusable even though it looks
 * like a food.
 */
function isKoraFoodSnapshot(value: unknown): value is KoraFoodSnapshot {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.name === "string" &&
    typeof f.updated_at === "string" &&
    typeof f.kcal_per_100g === "number"
  );
}

function isKoraFoodDetail(value: unknown): value is KoraFoodDetail {
  if (!value || typeof value !== "object") return false;
  const d = value as { food?: unknown; log_count?: unknown };
  return isKoraFoodSnapshot(d.food) && typeof d.log_count === "number";
}

/**
 * Turn a non-200 into a KoraAdminError carrying kora's own `code`/`message`.
 * Every mutation routes its failures through here so a 409 stays a 409 with
 * its reason intact — `stale_update` and `duplicate_barcode` are the two the
 * UI must be able to tell apart, and collapsing them into a generic failure
 * would make both unactionable.
 */
function throwKoraError(status: number, data: unknown, fallbackCode: string): never {
  const koraError = extractKoraError(data);
  throw new KoraAdminError(status, koraError?.error ?? fallbackCode, koraError?.message);
}

/**
 * Read `meta.cache_bump_failed` off a mutation response. Absent (kora's POST
 * carries no meta) or malformed reads as `false` — the flag is a warning
 * about cache freshness, so the safe default is "nothing to warn about"
 * rather than alarming an operator on every create.
 */
function readCacheBumpFailed(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return false;
  return (meta as { cache_bump_failed?: unknown }).cache_bump_failed === true;
}

/**
 * `GET /v1/admin/foods/:id` — the food plus its log-reference count.
 *
 * The edit form and the delete confirmation both need this endpoint rather
 * than the index: the index returns `nutrition.FoodItem`, which carries no
 * `updated_at` (PATCH's precondition) and no reference count.
 *
 * @param id MUST be a UUID. It is interpolated into the signed path, and
 * `koraAdmin`'s doc comment explains why an arbitrary string there is unsafe:
 * the path is signed raw but percent-encoded on the wire. A UUID is
 * ASCII-safe, so this is the encoding-free case — validated below rather than
 * assumed, since the caller is ultimately a URL segment.
 */
export async function getKoraFood(id: string): Promise<KoraFoodDetail> {
  assertUuid(id);
  const res = await koraAdmin<{ data: KoraFoodDetail }>("GET", `/foods/${id}`);
  if (res.status !== 200) throwKoraError(res.status, res.data, "get_food_failed");

  const detail = res.data?.data;
  if (!isKoraFoodDetail(detail)) {
    logger.warn(`[kora-admin] GET /foods/${id} -> 200 with an unexpected body shape`);
    throw new KoraAdminError(200, "unexpected_response_shape", "food detail response did not match the expected shape");
  }
  return detail;
}

/** `POST /v1/admin/foods`. Kora answers 201 on success, not 200. */
export async function createKoraFood(input: KoraFoodInput): Promise<KoraMutationResult> {
  const res = await koraAdmin<{ data: KoraFoodSnapshot }>("POST", "/foods", { body: input });
  // 201, not 200 — kora's create follows the repo's `c.JSON(StatusCreated,…)`
  // convention. Checking for 200 here would reject every successful create.
  if (res.status !== 201) throwKoraError(res.status, res.data, "create_food_failed");

  const food = res.data?.data;
  if (!isKoraFoodSnapshot(food)) {
    logger.warn("[kora-admin] POST /foods -> 201 with an unexpected body shape");
    throw new KoraAdminError(201, "unexpected_response_shape", "create response did not match the expected shape");
  }
  return { food, cacheBumpFailed: readCacheBumpFailed(res.data) };
}

/**
 * `PATCH /v1/admin/foods/:id`.
 *
 * @param expectedUpdatedAt the `updated_at` the caller LOADED. Kora only
 * applies the edit if the stored row still matches, and answers 409
 * `stale_update` otherwise — so two admins editing different fields of the
 * same food can no longer silently clobber each other. Required, not
 * optional: an optional precondition is one every caller forgets.
 */
export async function updateKoraFood(
  id: string,
  input: KoraFoodInput,
  expectedUpdatedAt: string,
): Promise<KoraMutationResult> {
  assertUuid(id);
  if (!expectedUpdatedAt) {
    throw new KoraAdminError(400, "missing_precondition", "updated_at is required to edit a food");
  }
  const res = await koraAdmin<{ data: KoraFoodSnapshot }>("PATCH", `/foods/${id}`, {
    body: { ...input, updated_at: expectedUpdatedAt },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "update_food_failed");

  const food = res.data?.data;
  if (!isKoraFoodSnapshot(food)) {
    logger.warn(`[kora-admin] PATCH /foods/${id} -> 200 with an unexpected body shape`);
    throw new KoraAdminError(200, "unexpected_response_shape", "update response did not match the expected shape");
  }
  return { food, cacheBumpFailed: readCacheBumpFailed(res.data) };
}

/**
 * `DELETE /v1/admin/foods/:id` — a SOFT delete (retirement).
 *
 * The returned snapshot carries `deleted_at`, which is the point of kora
 * returning a snapshot rather than a food item: the response can state that
 * the food is now retired. Callers should trust that field over assuming
 * success from the status alone.
 */
export async function deleteKoraFood(id: string): Promise<KoraMutationResult> {
  assertUuid(id);
  const res = await koraAdmin<{ data: KoraFoodSnapshot }>("DELETE", `/foods/${id}`);
  if (res.status !== 200) throwKoraError(res.status, res.data, "delete_food_failed");

  const food = res.data?.data;
  if (!isKoraFoodSnapshot(food)) {
    logger.warn(`[kora-admin] DELETE /foods/${id} -> 200 with an unexpected body shape`);
    throw new KoraAdminError(200, "unexpected_response_shape", "delete response did not match the expected shape");
  }
  // res.data, NOT food: `meta` sits alongside `data` in kora's envelope
  // (httpx.OKWithMeta), not inside the food.
  return { food, cacheBumpFailed: readCacheBumpFailed(res.data) };
}

/** One row of `kora_admin_events`. */
export interface KoraAdminEvent {
  id: string;
  actor_id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id?: string;
  before?: unknown;
  after?: unknown;
  created_at: string;
}

export interface KoraEventPage {
  items: KoraAdminEvent[];
  total: number;
}

function isKoraEventPage(value: unknown): value is KoraEventPage {
  if (!value || typeof value !== "object") return false;
  const page = value as { items?: unknown; total?: unknown };
  return Array.isArray(page.items) && typeof page.total === "number";
}

/**
 * `GET /v1/admin/events` — the admin audit trail, newest first.
 *
 * @param targetId optional; scopes the list to one food's history. Validated
 * as a UUID here because kora 400s a malformed one, and a 400 surfacing as
 * "the audit page is broken" is less useful than never sending it.
 */
export async function listKoraEvents(params: {
  targetId?: string;
  limit?: number;
  offset?: number;
}): Promise<KoraEventPage> {
  if (params.targetId) assertUuid(params.targetId);
  const res = await koraAdmin<{ data: KoraEventPage }>("GET", "/events", {
    search: {
      target_id: params.targetId ?? "",
      limit: params.limit ? String(params.limit) : "",
      offset: params.offset ? String(params.offset) : "",
    },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "list_events_failed");

  const page = res.data?.data;
  if (!isKoraEventPage(page)) {
    logger.warn("[kora-admin] GET /events -> 200 with an unexpected body shape");
    throw new KoraAdminError(200, "unexpected_response_shape", "audit response did not match the expected shape");
  }
  return page;
}

/**
 * Guards every id interpolated into a signed path. `koraAdmin` signs the raw
 * path string while `fetch` percent-encodes on the wire and Go percent-DECODES
 * — so a segment containing `%` or `/` makes the two disagree and produces a
 * 400-before-gin or a 401, neither of which reads as "bad id". A UUID is
 * ASCII-safe, so enforcing that shape removes the divergence entirely rather
 * than trying to encode around it.
 */
function assertUuid(id: string): void {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    throw new KoraAdminError(400, "invalid_id", "id must be a UUID");
  }
}

// ---------------------------------------------------------------------------
// Task 3: in-app feedback triage.
// ---------------------------------------------------------------------------

/** One row of Kora's in-app feedback, joined with the submitting user. */
export interface KoraFeedback {
  id: string;
  user_id: string;
  kind: string;
  subject: string;
  description: string;
  status: string;
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
  created_at: string;
  /** Joined from users — the feedback table stores no submitter identity. */
  email: string;
  /** May be "" for users created before display-name seeding landed. */
  display_name: string;
}

export interface KoraFeedbackPage {
  items: KoraFeedback[];
  total: number;
}

/**
 * What PATCH /v1/admin/feedback/:id actually returns: the bare feedback row,
 * with no `email`/`display_name`. Those two are a join that only the LIST
 * query performs (see `feedback.Item` vs `feedback.Feedback` on the Go
 * side) — kora's `UpdateStatus` re-reads the plain row, not the joined one.
 */
export type KoraFeedbackRow = Omit<KoraFeedback, "email" | "display_name">;

function isKoraFeedbackPage(value: unknown): value is KoraFeedbackPage {
  if (!value || typeof value !== "object") return false;
  const page = value as { items?: unknown; total?: unknown };
  return Array.isArray(page.items) && typeof page.total === "number";
}

function isKoraFeedbackRow(value: unknown): value is KoraFeedbackRow {
  if (!value || typeof value !== "object") return false;
  const f = value as { id?: unknown; status?: unknown };
  return typeof f.id === "string" && typeof f.status === "string";
}

/**
 * `GET /v1/admin/feedback` — in-app feedback, newest first.
 *
 * @param params.status/.kind MUST already be one of Kora's valid enum values
 * (`open|in_progress|resolved|closed` / `bug|feature`) — an unrecognised
 * value is a 400 from kora-api, not an ignored filter. Callers are
 * responsible for only passing valid values or omitting the filter.
 */
export async function listKoraFeedback(params: {
  status?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}): Promise<KoraFeedbackPage> {
  const res = await koraAdmin<{ data: KoraFeedbackPage }>("GET", "/feedback", {
    search: {
      status: params.status ?? "",
      kind: params.kind ?? "",
      limit: params.limit ? String(params.limit) : "",
      offset: params.offset ? String(params.offset) : "",
    },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "list_feedback_failed");

  const page = res.data?.data;
  if (!isKoraFeedbackPage(page)) {
    logger.warn("[kora-admin] GET /feedback -> 200 with an unexpected body shape");
    throw new KoraAdminError(200, "unexpected_response_shape", "feedback response did not match the expected shape");
  }
  return page;
}

/**
 * `PATCH /v1/admin/feedback/:id` — status is the only mutable field.
 *
 * @param id MUST be a UUID, validated below for the same reason as
 * `getKoraFood`'s `id` param: it is interpolated into the signed path, and
 * `koraAdmin` signs the raw path while `fetch` percent-encodes on the wire.
 */
export async function updateKoraFeedbackStatus(id: string, status: string): Promise<KoraFeedbackRow> {
  assertUuid(id);
  const res = await koraAdmin<{ data: KoraFeedbackRow }>("PATCH", `/feedback/${id}`, {
    body: { status },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "update_feedback_failed");

  const updated = res.data?.data;
  if (!isKoraFeedbackRow(updated)) {
    logger.warn("[kora-admin] PATCH /feedback -> 200 with an unexpected body shape");
    throw new KoraAdminError(200, "unexpected_response_shape", "feedback response did not match the expected shape");
  }
  return updated;
}
