import { cache } from "react";
import { logger } from "@/lib/logger";

// Reads published content of the `tesserix` tenant from the central Payload CMS,
// the same way yes-hospital/src/lib/cms.ts does. Server-side only.

/** The CMS could not be read. Callers fall back to the static data rather than rendering nothing. */
export class CmsError extends Error {
  name = "CmsError";
}

export const TENANT = "tesserix";

export type Media = {
  url?: string | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  sizes?: Partial<Record<"card" | "profile", { url?: string | null } | undefined>> | null;
};

// Anonymous reads return published docs of every tenant, so every query carries the tenant filter.
// limit=0 turns pagination off. cache(): one fetch (and one error log) per collection per request;
// Next's own fetch dedupe is off because of the abort signal.
export const find = cache(async (collection: string): Promise<unknown[]> => {
  const base = process.env.CMS_URL;
  if (!base) throw new CmsError("CMS_URL is not set");
  const url = `${base}/api/${collection}?where[tenant.slug][equals]=${TENANT}&depth=1&limit=0&sort=order`;
  try {
    // A hung CMS must not hang renders; the abort becomes a CmsError below.
    const signal = AbortSignal.timeout(Number(process.env.CMS_TIMEOUT_MS) || 5000);
    const res = await fetch(url, { signal, next: { revalidate: 60, tags: ["cms", `cms:${collection}`] } });
    if (!res.ok) throw new CmsError(`HTTP ${res.status}`);
    const body = (await res.json()) as { docs?: unknown };
    if (!Array.isArray(body.docs)) throw new CmsError("response has no docs array");
    return body.docs;
  } catch (err) {
    const wrapped = err instanceof CmsError ? err : new CmsError(String(err), { cause: err });
    logger.error(`CMS ${collection}: ${wrapped.message}; serving the built-in content`);
    throw wrapped;
  }
});

/** The static value when the CMS is unreadable or not configured; any other error propagates. */
export async function orFallback<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof CmsError) return fallback;
    throw err;
  }
}

// GCS serves absolute public URLs; local disk storage gives paths relative to the CMS.
// shortcut: a relative URL is prefixed with CMS_URL, which in the cluster is an internal host
// browsers cannot reach; fine while production media is on GCS, revisit if that changes.
export function mediaUrl(m: Media | number | null | undefined, size?: "card" | "profile"): string | undefined {
  if (typeof m !== "object" || !m) return undefined;
  const url = (size && m.sizes?.[size]?.url) || m.url;
  if (!url) return undefined;
  return url.startsWith("/") ? `${process.env.CMS_URL}${url}` : url;
}

export const opt = <T,>(v: T | null | undefined): T | undefined => v ?? undefined;
