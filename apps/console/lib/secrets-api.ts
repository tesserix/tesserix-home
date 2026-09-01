import { PlatformApiError } from "./platform-api-error";
import { parseSecretList } from "./secrets";
import type { SecretStore } from "./secrets";

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

  const { resolvePlatformApiToken } = await import("./auth/platform-token");
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
