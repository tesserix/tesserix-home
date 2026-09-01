import { notFound } from "next/navigation";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a "use client" module whose exports resolve to client
// references here. See tickets/[id]/page.tsx for the incident this guards
// against.
import {
  resolveState,
  toSurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchSecretDetail, fetchSecretVersions } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import type { SecretDetail, SecretStore, SecretVersion } from "@/lib/secrets";
import { SecretDetailView } from "./secret-detail-view";

/**
 * One secret's shape and version history — the row an operator reaches by
 * clicking through from `/platform/secrets`.
 *
 * # How the store reaches this route
 *
 * The catch-all segment (`[...path]`) carries the secret's path, but a path
 * alone does not identify a secret: the same path can exist in both OpenBao
 * and Google Secret Manager, and they are unrelated secrets that happen to
 * share a string. The store has to travel with the path.
 *
 * A search param (`?store=openbao`) was chosen over folding the store into
 * the catch-all segment itself (e.g. `/platform/secrets/openbao/homechef/...`).
 * The store is not part of the path's identity within a store — it is a
 * second, independent axis alongside it — and `secrets-table.tsx` already
 * has both values sitting right next to each other on the row it links from,
 * so building `?store=` there is a one-line addition rather than a path
 * rewrite. A catch-all prefix would also make it ambiguous whether the first
 * segment is the store or the first real path component whenever a mount
 * happens to be named `openbao` or `gcpsm`.
 *
 * `parseStoreParam` below fails closed: an absent or unrecognised value
 * returns `null`, and this page turns that into `notFound()` before any
 * fetch happens — never a default to `"openbao"`. Defaulting would show one
 * store's secret under the other store's identity, and on a secrets surface
 * that is not a cosmetic error: an operator could rotate what they believe is
 * the right credential and have actually rotated the wrong one.
 */

const KNOWN_STORES: readonly SecretStore[] = ["openbao", "gcpsm"];

/** Exported so the fail-closed contract above is unit-testable without
 *  rendering the page and catching `notFound()`'s special-cased redirect. */
export function parseStoreParam(raw: string | undefined): SecretStore | null {
  if (raw !== undefined && (KNOWN_STORES as readonly string[]).includes(raw)) {
    return raw as SecretStore;
  }
  return null;
}

/**
 * Which state the detail surface is in.
 *
 * Mirrors `tickets/[id]/page.tsx`'s `detailState`: `notFound()` covers both
 * "no such store" and a genuine 404 from secrets-api before this ever runs,
 * so a null detail with no error here means the upstream call returned
 * something that failed to parse — `empty` is the honest reading of that,
 * and `SecretDetailView` renders the kit's own copy for it.
 */
export function detailState(input: {
  error: unknown;
  detail: SecretDetail | null;
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.detail ? [input.detail] : [],
    filtered: false,
  });
}

export default async function SecretDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ store?: string }>;
}) {
  const { path: pathSegments } = await params;
  const { store: rawStore } = await searchParams;

  const store = parseStoreParam(rawStore);
  if (store === null) {
    notFound();
  }

  const path = pathSegments.join("/");

  let detail: SecretDetail | null = null;
  let versions: SecretVersion[] = [];
  let error: unknown = null;
  try {
    [detail, versions] = await Promise.all([
      fetchSecretDetail(store, path),
      fetchSecretVersions(store, path),
    ]);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      notFound();
    }
    error = caught;
  }

  const state = detailState({ error, detail });

  return (
    <SecretDetailView store={store} path={path} detail={detail} versions={versions} state={state} />
  );
}
