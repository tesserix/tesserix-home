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
// Two bounds, both deliberate:
//
//   MAX_DEPTH  — a backend that returned a folder containing itself would
//                otherwise recurse until the page hung. A bounded walk that
//                returns a short list is diagnosable; a hang is not.
//   MAX_NODES  — caps the request count for a pathological tree, so one bad
//                prefix cannot turn a page load into hundreds of upstream
//                calls.
//
// The walk is breadth-first rather than depth-first: a bounded BFS degrades
// gracefully (you still get the shallow, common secrets first) where a
// bounded DFS could spend its whole budget descending one deep corner and
// return nothing useful from the rest of the tree.
//
// A visited set on the prefix is what actually terminates a cycle (a folder
// that lists itself, or a longer loop); MAX_DEPTH is the backstop for a
// cycle the visited set does not catch and for legitimately deep trees.
const MAX_DEPTH = 8;
const MAX_NODES = 512;

/**
 * Every leaf secret path in `store`, mount-relative (e.g.
 * `homechef/homechef-api/db-password`, never `kv/homechef/...` — the API adds
 * the KV mount itself). Folders are traversed, not returned.
 *
 * Task 2's matching rule compares these paths against `${namespace}/${app}`
 * prefixes, so a stray leading slash would break every match silently, by
 * flagging every secret as unreadable.
 */
export async function fetchSecretPaths(store: SecretStore): Promise<string[]> {
  const paths: string[] = [];
  const visited = new Set<string>();
  let frontier: Array<{ prefix: string; depth: number }> = [{ prefix: "/", depth: 0 }];
  let requests = 0;

  while (frontier.length > 0 && requests < MAX_NODES) {
    const next: Array<{ prefix: string; depth: number }> = [];

    for (const { prefix, depth } of frontier) {
      if (visited.has(prefix)) continue;
      visited.add(prefix);

      if (requests >= MAX_NODES) break;
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
        if (depth + 1 >= MAX_DEPTH) continue;
        const childPrefix = `/${path}/`;
        if (!visited.has(childPrefix)) {
          next.push({ prefix: childPrefix, depth: depth + 1 });
        }
      }
    }

    frontier = next;
  }

  return paths;
}
