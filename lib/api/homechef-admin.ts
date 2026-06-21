// Server-side signed client for the HomeChef Go API's /admin/* endpoints.
//
// The Go API gates /api/v1/admin/* with BFFAuth (apps/api/middleware/bff_auth.go):
// it accepts requests carrying an HMAC-signed header set produced by the
// auth-bff header-proxy. tesserix-home becomes a SECOND trusted signer — it
// signs requests itself and calls the Go API directly (in-cluster), so every
// admin read/write flows through the Go API (preserving Temporal/NATS/Redis/
// escrow side-effects) with ZERO Go API changes.
//
// Wire format (must match bff_auth.go:compute exactly — drift = 401):
//   X-Internal-Auth = HMAC_SHA256( "${method}\n${path}\n${sha256hex(body)}\n${ts}", key )
//   + X-User-Id, X-User-Email, X-User-Role, X-Auth-Pool, X-Auth-Ts
// where `path` is the Go server's r.URL.Path (query string excluded) and `key`
// is the base64-decoded shared HMAC secret (same as the Go side's
// BFF_INTERNAL_HMAC_KEY / GCP prod-homechef-bff-internal-hmac-key).
import crypto from "node:crypto";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const API_URL = process.env.HOMECHEF_API_URL ?? "";
const HMAC_KEY_B64 = process.env.HOMECHEF_BFF_HMAC_KEY ?? "";

/** Every HomeChef admin endpoint lives under this prefix on the Go server. */
export const ADMIN_PREFIX = "/api/v1/admin";

export class HomechefAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HomechefAdminError";
  }
}

/**
 * Mirrors `compute()` in apps/api/middleware/bff_auth.go:203 exactly.
 * Pure + exported so the unit test can pin it to a fixed vector (drift guard).
 */
export function computeSignature(
  method: string,
  path: string,
  body: Buffer,
  ts: string,
  key: Buffer,
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const mac = crypto.createHmac("sha256", key);
  mac.update(`${method}\n${path}\n${bodyHash}\n${ts}`);
  return mac.digest("hex");
}

export interface AdminActor {
  userId: string;
  email: string;
}

/**
 * Builds the full signed header set for a HomeChef admin call. The acting
 * admin's id/email are carried for audit; role/pool are pinned to admin/internal
 * (the calling route is already gated to admin sessions by middleware.ts).
 * Pure (takes `now` + key) so it is unit-testable.
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
  const ts = Math.floor(now / 1000).toString();
  return {
    "Content-Type": "application/json",
    "X-User-Id": actor.userId,
    "X-User-Email": actor.email,
    "X-User-Role": "admin",
    "X-Auth-Pool": "internal",
    "X-Auth-Ts": ts,
    "X-Internal-Auth": computeSignature(method, path, body, ts, key),
  };
}

export type AdminMethod = "GET" | "POST" | "PUT" | "DELETE";

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
          // drop empty values so `?status=` doesn't leak through
          Object.fromEntries(Object.entries(search).filter(([, v]) => v !== "")),
        ).toString();
  return qs ? `?${qs}` : "";
}

/**
 * Call a HomeChef admin endpoint, signed as a trusted BFF.
 * @param adminPath path UNDER /admin, e.g. "/chefs" or "/chefs/123/verify".
 */
export async function homechefAdmin<T = unknown>(
  method: AdminMethod,
  adminPath: string,
  opts: RequestOptions = {},
): Promise<AdminResponse<T>> {
  if (!API_URL || !HMAC_KEY_B64) {
    throw new HomechefAdminError(
      500,
      "not_configured",
      "HOMECHEF_API_URL / HOMECHEF_BFF_HMAC_KEY are not set",
    );
  }
  const session = await getCurrentSession();
  if (!session) throw new HomechefAdminError(401, "no_session");

  const path = `${ADMIN_PREFIX}${adminPath.startsWith("/") ? adminPath : `/${adminPath}`}`;
  const bodyBytes =
    opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0);
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
      // never cache admin reads
      cache: "no-store",
    });
  } catch (err) {
    logger.error("[homechef-admin] upstream unreachable", err);
    throw new HomechefAdminError(502, "upstream_unreachable");
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
    logger.warn(`[homechef-admin] ${method} ${path} -> ${res.status}`);
  }
  return { status: res.status, data: data as T };
}
