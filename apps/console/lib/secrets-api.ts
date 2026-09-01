// `server-only`: this reads the estate's secret stores through a token
// resolved from the operator-token store. A client component importing this
// file — even via a dynamic `import()`, which is exactly a lazy chunk — must
// fail the BUILD with a message naming the cause, not ship server code to the
// browser silently. See `./health.ts`, `./outbox.ts` and `./tools-directory.ts`
// for the same guard on the same shape of surface.
import "server-only";

import { PlatformApiError } from "./platform-api-error";
import { buildInventory, parseGrants, parseSecretDetail, parseSecretList, parseSecretVersions } from "./secrets";
import type { SecretDetail, SecretsInventory, SecretStore, SecretVersion } from "./secrets";

/** A rejection is not guaranteed to be an `Error` — an undefined `.message`
 *  would read as a mystery failure. Narrow before formatting. Mirrors
 *  `describe` in `platform-api.ts`. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Where secrets-api lives. A second origin, not a second client: the token,
 * the token store and the error type are all shared with platform-api,
 * because both services verify the same Zitadel project audience and the
 * console holds exactly one operator token.
 *
 * Read at call time, not at module load, so tests can stub it and so a
 * misconfigured deployment reports the problem per request rather than
 * failing to start.
 */
export function secretsApiOrigin(): string | undefined {
  const raw = (process.env.SECRETS_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return raw === "" ? undefined : raw;
}

/**
 * Resolves `./auth/platform-token` exactly once per module instance, into a
 * cached promise every `secretsRequest` call awaits.
 *
 * `import("./auth/platform-token")` is dynamic (not a static top-level
 * import) for a real reason unrelated to this cache: a static import drags
 * in the operator-token store, and through it `pg`, into any client bundle
 * that reaches this module — see the identical reasoning documented on
 * `PlatformApiError`. Memoising the *promise* rather than switching to a
 * static import preserves that property; the import still only happens at
 * first call, lazily, and only on the server.
 *
 * The memo is also what let `fetchSecretsInventory` go back to firing its
 * several `secretsRequest` calls concurrently (`Promise.all`). Without it,
 * each call did its own first-time `import("./auth/platform-token")`, and
 * two of those concurrent first-imports of the same specifier raced under
 * Vitest's SSR module runner rewiring its mock graph — confirmed in
 * isolation with nothing but `Promise.all([secretsRequest(...),
 * secretsRequest(...)])` sharing a `vi.mock` — with one of the two
 * resolving the *real* module instead of the mock, throwing `cookies() was
 * called outside a request scope`. That is not a claim about ESM generally:
 * the module loader dedupes `import()` by resolved specifier, so concurrent
 * first-time imports of the same module do not race there, and nothing here
 * was observed to race outside this test runner's mock rewiring. The memo
 * removes the race by removing the repeated `import()` calls it depends on
 * — every caller now awaits the one promise resolved here — which also
 * happens to mean the module is only ever resolved once instead of once per
 * request.
 */
let tokenModule: Promise<typeof import("./auth/platform-token")> | undefined;
function platformTokenModule(): Promise<typeof import("./auth/platform-token")> {
  tokenModule ??= import("./auth/platform-token");
  return tokenModule;
}

/**
 * Test-only escape hatch: clears the memo above so a fresh per-test
 * `vi.doMock("./auth/platform-token", ...)` actually takes effect on the
 * next `secretsRequest` call.
 *
 * Production never calls this — one server process is one long-lived module
 * instance, so the memo is filled exactly once and stays filled for the
 * process's life, which is the whole point of it (see `platformTokenModule`'s
 * comment). Tests are different: many "sessions" (different tokens,
 * `reauthRequired` values) share this one module instance across a single
 * `vitest run`, and `vi.resetModules()` is too blunt a fix for that — it
 * would also hand out a fresh `PlatformApiError` class per test, breaking
 * every `instanceof PlatformApiError` check against the class this test file
 * imported once at the top (see the class's own doc comment on exactly this
 * failure mode). Resetting only this one memo, not the whole module
 * registry, avoids that.
 */
export function __resetPlatformTokenModuleForTests(): void {
  tokenModule = undefined;
}

/**
 * A single GET-style call against secrets-api, mirroring `platformCall`'s
 * shape (the unwrapping-to-`.data` layer above it, `platformRequest`, has no
 * counterpart here yet — secrets-api does not speak the same envelope). The
 * operator token is the only credential this service accepts, so a missing
 * token is refused before the network call rather than sent and left to come
 * back as an indistinguishable 401.
 */
export async function secretsRequest(label: string, path: string): Promise<unknown> {
  const origin = secretsApiOrigin();
  if (!origin) {
    throw new PlatformApiError(`${label}: SECRETS_API_ORIGIN is not set`, 501);
  }

  const { resolvePlatformApiToken } = await platformTokenModule();
  const { token, reauthRequired } = await resolvePlatformApiToken();
  if (!token) {
    // The marker is set ONLY for the absence a fresh sign-in mints a token
    // for. Marking every tokenless case would tell an operator to sign in
    // again when the encryption key is unset or tesserix-postgres is down —
    // an infrastructure failure dressed as a session failure. See the
    // identical reasoning in `platformCall`.
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
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (cause) {
    throw new PlatformApiError(`${label}: request failed (${describe(cause)})`, undefined, {
      cause,
    });
  }

  if (!response.ok) {
    // The upstream status is preserved rather than flattened. 403 (lacks the
    // `platform` capability) and 401 (session gone) need different answers
    // from the caller, and only the status tells them apart.
    throw new PlatformApiError(`${label}: secrets-api returned ${response.status}`, response.status);
  }

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

// secrets-api lists one level at a time (`GET /api/secrets?prefix=…`), so
// assembling the estate-wide inventory means walking the tree ourselves.
// There is no flat-inventory endpoint to fall back on.
//
// MAX_DEPTH is what actually bounds the walk, and the bound is total, not a
// backstop: a child's prefix is always strictly longer than its parent's
// (path composition only ever appends — see `parseSecretList`'s rejection of
// empty and "/"-containing names, which is what makes that hold), so depth
// strictly increases and the same prefix can never recur along a root-to-leaf
// chain. That is the whole termination argument, and it depends on the name
// validation staying in place — relax it and a cycle becomes possible again.
//
// The visited set is not a termination mechanism; it deduplicates repeated
// entries (the same folder name listed twice in one response, or the same
// subtree reachable more than once) so they cost one request instead of two.
//
// MAX_NODES bounds the total request count for a wide tree, independently of
// depth.
//
// The walk is breadth-first rather than depth-first: a bounded BFS degrades
// gracefully (you still get the shallow, common secrets first) where a
// bounded DFS could spend its whole budget descending one deep corner and
// return nothing useful from the rest of the tree.
const MAX_DEPTH = 8;
const MAX_NODES = 512;

/** The estate walk's result: the paths found, plus whether the walk actually
 *  reached every leaf or was cut off by one of the two bounds. */
export interface SecretWalkResult {
  readonly paths: string[];
  /**
   * `false` when `MAX_NODES` or `MAX_DEPTH` stopped the walk before the tree
   * was exhausted. This surface exists to answer "which secrets have no
   * reader" — a question a truncated list answers wrongly by omission, not
   * approximately. A caller that renders `paths` without checking this flag
   * would present a partial estate as if it were the whole one, silently
   * turning "we didn't look" into "it isn't there".
   *
   * Reaching `MAX_DEPTH` only counts as truncation if a folder was actually
   * declined at the limit; a tree that happens to bottom out in leaves at
   * exactly that depth, with nothing left to expand, is complete.
   */
  readonly complete: boolean;
}

/**
 * Every leaf secret path in `store`, mount-relative (e.g.
 * `homechef/homechef-api/db-password`, never `kv/homechef/...` — the API adds
 * the KV mount itself). Folders are traversed, not returned.
 *
 * Task 2's matching rule compares these paths against `${namespace}/${app}`
 * prefixes, so a stray leading slash would break every match silently, by
 * flagging every secret as unreadable.
 *
 * A prefix that fails outright (a non-2xx from `secretsRequest`, including a
 * 404 mid-walk) rejects the whole call rather than being swallowed into a
 * smaller `paths` array. A partial list here reads as "these are the only
 * secrets" to a surface whose entire job is flagging what's missing — a
 * silently-shrunk inventory is a worse answer than an explicit failure the
 * caller can show as "the inventory couldn't be read", so this walk fails
 * loud instead of guessing.
 */
export async function fetchSecretPaths(store: SecretStore): Promise<SecretWalkResult> {
  const paths: string[] = [];
  const visited = new Set<string>();
  // A flat FIFO queue rather than level-by-level batches: BFS order only
  // requires shifting from the front and pushing children to the back, and
  // keeping it flat makes the two truncation signals below a single flag
  // each, set at the exact point a bound actually bites.
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix: "/", depth: 0 }];
  let requests = 0;
  // Two independent truncation signals, because either bound can fire without
  // the other: a wide-but-shallow tree can hit MAX_NODES with no folder ever
  // near MAX_DEPTH, and a narrow-but-deep tree can hit MAX_DEPTH having made
  // far fewer than MAX_NODES requests.
  let nodeCapHit = false;
  let depthLimitHit = false;

  while (queue.length > 0) {
    if (requests >= MAX_NODES) {
      // Work remains in the queue that the node cap forbids fetching — the
      // walk stops here without ever seeing it.
      nodeCapHit = true;
      break;
    }

    // Non-null: `queue.length > 0` was just checked above.
    const { prefix, depth } = queue.shift()!;
    if (visited.has(prefix)) continue;
    visited.add(prefix);
    requests += 1;

    const json = await secretsRequest(
      "secrets",
      `/api/secrets?backend=${encodeURIComponent(store)}&prefix=${encodeURIComponent(prefix)}`,
    );
    const entries = parseSecretList(json);

    // Trim the parent prefix's leading AND trailing slashes so composed
    // child paths carry neither — a stray "/mark8ly/db" or "mark8ly//db"
    // would fail to match the "${namespace}/${app}" prefixes Task 2
    // compares against.
    const base = prefix.replace(/^\/+|\/+$/g, "");

    for (const entry of entries) {
      const path = base === "" ? entry.name : `${base}/${entry.name}`;
      if (!entry.isFolder) {
        paths.push(path);
        continue;
      }
      if (depth + 1 >= MAX_DEPTH) {
        // A folder sat right at the limit and was declined — this is the
        // "actually declined a folder" case the doc comment distinguishes
        // from a tree that simply has nothing below this depth.
        depthLimitHit = true;
        continue;
      }
      const childPrefix = `/${path}/`;
      if (!visited.has(childPrefix)) {
        queue.push({ prefix: childPrefix, depth: depth + 1 });
      }
    }
  }

  return { paths, complete: !nodeCapHit && !depthLimitHit };
}

// The stores this console knows how to render. `buildInventory` has exactly
// two slots (`openbao`, `gcpsm`) and nowhere to put a third store's paths
// without a code change here, so this is also the set `fetchSecretsInventory`
// is willing to walk — see the comment there for what happens when
// `/api/backends` reports something outside it.
const KNOWN_STORES: readonly SecretStore[] = ["openbao", "gcpsm"];

function isKnownStore(name: string): name is SecretStore {
  return (KNOWN_STORES as readonly string[]).includes(name);
}

/**
 * Parse `GET /api/backends`'s response into the backend names this
 * deployment has enabled (`{"backends": [...], "default": "..."}`).
 *
 * Kept minimal and local rather than promoted to `secrets.ts`'s
 * boundary-parser style: nothing else in the console reuses this shape, and
 * `default` is not read at all — the inventory walk needs every enabled
 * backend, not the one a single-store picker would default to.
 */
function parseBackendNames(json: unknown): string[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("secrets: /api/backends response is not an object");
  }
  const backends = (json as { backends?: unknown }).backends;
  if (!Array.isArray(backends) || !backends.every((b): b is string => typeof b === "string")) {
    throw new Error("secrets: /api/backends .backends is not an array of strings");
  }
  return backends;
}

/**
 * Assemble the console's secrets inventory: ask `/api/backends` which stores
 * this deployment has enabled, walk each one this console knows how to
 * render, read the OpenBao grants, and hand all three to `buildInventory`.
 *
 * The enabled-backend list is read from the API on every call — never
 * hardcoded to `["openbao", "gcpsm"]`. A deployment can run a subset (e.g.
 * OpenBao only, before GSM is provisioned), and walking a store the API
 * never enabled would surface as an opaque per-request error the operator
 * cannot act on, instead of the API's own authoritative answer about what
 * exists here.
 *
 * A backend name `/api/backends` reports that this console does not
 * recognise (a future third store) is IGNORED, not treated as a failure:
 * `buildInventory` has no slot to put its paths in without a code change
 * here regardless, so failing loud would take down the whole inventory page
 * over a store this code was never taught to render — worse than rendering
 * what it does know. Because it is ignored rather than attempted-and-cut-off,
 * it does not count against `complete` either: the console did not fail to
 * finish looking at it, it was never asked to look. (If a future reader
 * decides an unrecognised backend should instead be surfaced loudly — e.g.
 * once a third store is common enough that silently dropping it is more
 * surprising than an error — that's a deliberate change to this comment and
 * the filter below, not a bug fix.)
 */
export async function fetchSecretsInventory(): Promise<SecretsInventory> {
  const backendsJson = await secretsRequest("backends", "/api/backends");
  const enabled = parseBackendNames(backendsJson).filter(isKnownStore);

  // Concurrent: the two stores' walks and the grants read have no ordering
  // requirement between them, and each store's walk is already many
  // sequential requests on its own — serialising the stores too would
  // roughly double this page's wall-clock for no product reason. This is
  // safe to run concurrently because `platformTokenModule` (see its comment)
  // resolves the operator-token module exactly once and every caller awaits
  // that same cached promise, so there is no first-import race between
  // these three calls.
  // `Promise.all` rejects the whole call if any one of these three requests
  // fails outright (a network error, a non-2xx from `secretsRequest`) —
  // deliberately, not merely as a consequence of using `Promise.all`. A
  // failed request means we do not know what that store's secrets are at
  // all; that's a different situation from a walk that ran and reports
  // `complete: false`, where we know exactly what we didn't see. Collapsing
  // the former into a partial inventory would present "we couldn't ask" as
  // if it were "we asked and some was missing" — the same silent-shrinkage
  // failure `fetchSecretPaths`'s own doc comment argues against for a single
  // store, just one level up.
  // The grants read is gated on "openbao" being enabled for the same reason
  // the walks above are: secrets-api registers `/api/access/grants` only when
  // OpenBao is configured (`secrets-api/internal/api/server.go`, `if
  // d.Bao != nil`), so a GSM-only deployment 404s on this call unconditionally
  // and `Promise.all` rejects the whole inventory over a store that was never
  // walked. An empty grants list changes nothing when it's skipped: with no
  // OpenBao there are no OpenBao rows to match against grants, and GSM rows
  // always carry `hasReader: null` regardless of what `grants` contains.
  const [openbaoResult, gcpsmResult, grantsJson] = await Promise.all([
    enabled.includes("openbao") ? fetchSecretPaths("openbao") : Promise.resolve(null),
    enabled.includes("gcpsm") ? fetchSecretPaths("gcpsm") : Promise.resolve(null),
    enabled.includes("openbao")
      ? secretsRequest("access grants", "/api/access/grants")
      : Promise.resolve({ grants: [] }),
  ]);

  const grants = parseGrants(grantsJson);
  const data = buildInventory({
    openbao: openbaoResult?.paths ?? [],
    gcpsm: gcpsmResult?.paths ?? [],
    grants,
  });

  // Complete only if every store that was actually walked reported complete
  // — a store never enabled (and so never walked) cannot make the inventory
  // incomplete, but a truncated one sinks the whole inventory's flag, not
  // just its own rows. See `SecretsInventory`'s doc comment for why.
  const complete = [openbaoResult, gcpsmResult].every((r) => r === null || r.complete);

  return { ...data, complete };
}

/**
 * `path` is mount-relative, exactly as `fetchSecretPaths` produces it (e.g.
 * `homechef/homechef-api/db-password`, never `/homechef/...` or
 * `kv/homechef/...`). `secrets-api` matches `/api/secrets/*path`, so the
 * leading slash belongs to the URL built here, not to the stored path — see
 * the module doc comment on `fetchSecretPaths` for why a stray one breaks
 * every match silently. Each segment is encoded on its own so a literal "/"
 * inside a segment (which `parseSecretList` already rejects at the listing
 * boundary — see `secrets.ts`) can never be produced by this call either.
 */
function encodeSecretPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * A secret's current shape: `GET /api/secrets/*path?backend=…`, returning
 * the bare `secrets.Secret` struct (see `parseSecretDetail`'s doc comment for
 * why nothing here ever carries a value).
 */
export async function fetchSecretDetail(store: SecretStore, path: string): Promise<SecretDetail> {
  const json = await secretsRequest(
    "secret detail",
    `/api/secrets/${encodeSecretPath(path)}?backend=${encodeURIComponent(store)}`,
  );
  return parseSecretDetail(json);
}

/**
 * A secret's version history: `GET /api/secret-versions/*path?backend=…`.
 */
export async function fetchSecretVersions(store: SecretStore, path: string): Promise<SecretVersion[]> {
  const json = await secretsRequest(
    "secret versions",
    `/api/secret-versions/${encodeSecretPath(path)}?backend=${encodeURIComponent(store)}`,
  );
  return parseSecretVersions(json);
}
