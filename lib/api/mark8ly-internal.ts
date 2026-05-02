// HTTP client for mark8ly's /internal endpoints. Currently used to
// ping the templates cache after a tesserix-home edit and to trigger
// test-sends from the admin UI. In-cluster traffic; no auth header
// required (network policy + istio restrict who can hit /internal).
//
// In dev/local, MARK8LY_PLATFORM_API_URL points at localhost; in
// prod it should be the in-cluster URL (saves egress through CF).

import { logger } from "@/lib/logger";

const PLATFORM_API_URL =
  process.env.MARK8LY_PLATFORM_API_URL ??
  "http://platform-api.mark8ly.svc.cluster.local";
const TIMEOUT_MS = 10_000;

async function postJSON(path: string, body: unknown): Promise<Response> {
  const url = `${PLATFORM_API_URL}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(t);
  }
}

// Fire-and-forget cache eviction after an authored change. Best-effort:
// failure here just means changes propagate via the 5-min TTL instead of
// instantly, so we log and swallow rather than failing the save action.
export async function refreshTemplateCache(key: string): Promise<void> {
  try {
    const res = await postJSON("/internal/templates/refresh", { key });
    if (!res.ok) {
      logger.warn("[mark8ly-internal] templates/refresh non-2xx", {
        key,
        status: res.status,
      });
    }
  } catch (err) {
    logger.warn("[mark8ly-internal] templates/refresh failed", {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface TestSendInput {
  readonly key: string;
  readonly to: string;
  readonly vars: Record<string, unknown>;
}

export interface TestSendResult {
  readonly ok: boolean;
  readonly status: number;
  readonly errorMessage: string | null;
}

// Fires a test send through mark8ly's send pipeline. Errors are
// surfaced (not swallowed) because the operator clicked a button and
// expects feedback.
export async function sendTestEmail(input: TestSendInput): Promise<TestSendResult> {
  try {
    const res = await postJSON(`/internal/templates/${encodeURIComponent(input.key)}/test`, {
      to: input.to,
      vars: input.vars,
    });
    if (res.ok) {
      return { ok: true, status: res.status, errorMessage: null };
    }
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      errorMessage: body.slice(0, 500),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
