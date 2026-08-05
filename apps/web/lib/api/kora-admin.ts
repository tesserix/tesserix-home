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
    });
  } catch (err) {
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
