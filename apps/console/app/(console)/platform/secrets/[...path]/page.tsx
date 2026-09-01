import { notFound } from "next/navigation";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a "use client" module whose exports resolve to client
// references here. See tickets/[id]/page.tsx for the incident this guards
// against.
import {
  resolveState,
  toSurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchGrants, fetchSecretDetail, fetchSecretVersions } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { requiresCapability } from "@/lib/internal-access";
import { readersFor } from "@/lib/secrets";
import type { Grant, SecretDetail, SecretStore, SecretVersion } from "@/lib/secrets";
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
  let readers: Grant[] = [];
  let error: unknown = null;
  try {
    // The `fetchGrants` leg is deliberately NOT given its own `.catch(() =>
    // [])` to keep a grants-read failure from taking down the rest of this
    // page. That would default `readers` to `[]` on a fetch failure — and an
    // empty grants list is exactly the "no app can read this" ALARM state
    // this whole card exists to raise (spec §6). A defaulted `[]` would be
    // indistinguishable from a genuine orphaned secret, turning "not
    // knowable right now" into a false all-clear that reads as a false
    // alarm — a lie in the opposite direction is still a lie. The honest
    // alternative — a card-level error state that says "the reader list
    // could not be read" rather than "no one can read this" — is real
    // scope, not a one-line change, and is not implemented here.
    const [fetchedDetail, fetchedVersions, grants] = await Promise.all([
      fetchSecretDetail(store, path),
      fetchSecretVersions(store, path),
      // Skipped for GSM, for two independent reasons — see `readersFor`'s
      // call below for how the empty result flows through, and never
      // "GSM has no readers": `secrets-api` only registers
      // `/api/access/grants` when OpenBao is configured (`if d.Bao != nil`
      // in `secrets-api/internal/api/server.go`), so on a GSM-only
      // deployment the route 404s outright and would fail this whole
      // `Promise.all` over a call nobody needs the answer to; and even on a
      // deployment where OpenBao IS configured, a GSM secret's readers are
      // IAM bindings this console cannot see, so the answer would be
      // meaningless for that store regardless of whether the route exists.
      // Mirrors the identical guard in `fetchSecretsInventory`
      // (`lib/secrets-api.ts`).
      store === "openbao" ? fetchGrants() : Promise.resolve([]),
    ]);
    detail = fetchedDetail;
    versions = fetchedVersions;
    // Safe to call unconditionally: with `grants` forced to `[]` for a GSM
    // secret above, this always returns `[]` there too — `AccessCard`
    // (`access-card.tsx`) is what actually decides not to render a reader
    // list for GSM, and it decides that from `store`, not from `readers`
    // being empty.
    readers = readersFor(path, grants);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      notFound();
    }
    error = caught;
  }

  const state = detailState({ error, detail });

  // THE RENDER PATH, NOT THE CONTROL. Writing requires `platform` AND
  // `rotate-credentials` together — `secrets-api` enforces that itself on
  // `PUT /api/secrets/*path` (that route sits in its `live` tier), so a
  // `platform`-only operator gets refused by the API regardless of what this
  // page draws. This check exists only so the console does not offer a
  // control that is guaranteed to 403 — it is the same
  // `!requiresCapability() || hasCapability(session?.roles, …)` shape every
  // other render-path gate in this console uses (`tickets/[id]/page.tsx`,
  // `billing/catalog/page.tsx`), reading the session cookie's snapshot
  // synchronously rather than the live gate: hiding a button is UX, not
  // authorization, and `render-path-capabilities.test.ts` is what keeps that
  // distinction from drifting.
  const session = await getCurrentSession();
  const canWrite =
    !requiresCapability() ||
    (hasCapability(session?.roles, "platform") &&
      hasCapability(session?.roles, "rotate-credentials"));

  return (
    <SecretDetailView
      store={store}
      path={path}
      detail={detail}
      versions={versions}
      readers={readers}
      state={state}
      canWrite={canWrite}
    />
  );
}
