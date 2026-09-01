/**
 * The secrets inventory: every secret in the estate, flagging any that no
 * application can read.
 *
 * Two stores, two very different notions of "who can read this":
 *   - OpenBao: the console can see the grants (Kubernetes auth roles bound to
 *     a namespace/app prefix), so it can compute the flag itself.
 *   - Google Secret Manager: readers are IAM bindings the console does not
 *     see. It cannot claim "no reader" there without possibly being wrong, so
 *     that store never sets the flag — see `buildInventory`.
 */

function fail(message: string): never {
  throw new Error(`secrets: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} is not a boolean`);
  return value;
}

export type SecretStore = "openbao" | "gcpsm";

/** One entry in a directory listing — either a secret or a folder of them. */
export interface SecretListEntry {
  readonly name: string;
  readonly isFolder: boolean;
}

/** One row of the secrets inventory. */
export interface InventoryRow {
  readonly path: string;
  readonly store: SecretStore;
  /**
   * `null` means "not knowable here" (GCP Secret Manager), a fact distinct
   * from `false` ("knowable, and no grant covers it"). Never widen this to
   * `boolean` — a `!hasReader` count would then silently include every GSM
   * row, because `!null` is `true`.
   */
  readonly hasReader: boolean | null;
}

export interface SecretsInventory {
  readonly rows: readonly InventoryRow[];
  readonly counts: {
    readonly all: number;
    readonly openbao: number;
    readonly gcpsm: number;
    readonly noReader: number;
  };
}

/** One app's read grant, identified by the namespace/app prefix it covers. */
export interface Grant {
  readonly namespace: string;
  readonly app: string;
}

/**
 * Parse a secret-listing response (`GET /api/secrets/...`-shaped) into its
 * entries.
 *
 * Strict, like `lib/tenants.ts`'s `parseEstateTenants`: a malformed entry
 * throws rather than silently defaulting. In particular `isFolder` missing
 * must not become `false` — a folder rendered as a secret would be listed as
 * one and then fail to describe.
 */
export function parseSecretList(json: unknown): SecretListEntry[] {
  if (!isRecord(json)) fail("response is not an object");
  if (!Array.isArray(json.entries)) fail("entries is not an array");
  return json.entries.map((entry, i) => {
    if (!isRecord(entry)) fail(`entries[${i}] is not an object`);
    const name = str(entry.name, `entries[${i}].name`);
    // This is the boundary parser: every caller — in particular the estate
    // walk in `secrets-api.ts` — composes `name` directly into a path it then
    // matches against a "${namespace}/${app}" grant prefix. A "/" inside a
    // name would silently merge or split a path segment nobody asked for; an
    // empty name would compose a path with a missing segment or a bare
    // trailing slash. Both cross that boundary exactly as silently as each
    // other, so both are rejected here rather than left to whichever caller
    // happens to notice first.
    if (name === "") fail(`entries[${i}].name is empty`);
    if (name.includes("/")) fail(`entries[${i}].name contains a "/" (${JSON.stringify(name)})`);
    return {
      name,
      isFolder: bool(entry.isFolder, `entries[${i}].isFolder`),
    };
  });
}

/**
 * Parse `GET /api/access/grants`'s response into the namespace/app pairs that
 * matter for matching.
 *
 * `secretPrefix` is deliberately dropped here, not just unused: secrets-api's
 * two constructors set it inconsistently (`GrantAll` omits the mount,
 * `Grants` — the endpoint this reads — includes it), so it cannot be matched
 * against a mount-relative secret path without knowing which one produced it.
 * `namespace` and `app` are set identically by both and are mount-independent.
 */
export function parseGrants(json: unknown): Grant[] {
  if (!isRecord(json)) fail("response is not an object");
  if (!Array.isArray(json.grants)) fail("grants is not an array");
  return json.grants.map((grant, i) => {
    if (!isRecord(grant)) fail(`grants[${i}] is not an object`);
    const namespace = str(grant.namespace, `grants[${i}].namespace`);
    const app = str(grant.app, `grants[${i}].app`);
    if (namespace === "") fail(`grants[${i}].namespace is empty`);
    if (app === "") fail(`grants[${i}].app is empty`);
    return { namespace, app };
  });
}

/**
 * Does some grant give a reader to the secret at `path`?
 *
 * A grant covers its own prefix (`namespace/app`) and everything beneath it
 * (`namespace/app/...`). The trailing slash on the "beneath" check is load
 * bearing: without it, a grant for app `api` would also match `api-internal`,
 * claiming a reader that does not exist.
 */
function hasGrantFor(path: string, grants: readonly Grant[]): boolean {
  return grants.some((g) => {
    const prefix = `${g.namespace}/${g.app}`;
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/**
 * Build the secrets inventory from the raw listings of each store plus the
 * OpenBao grants.
 *
 * Two rules, from the predecessor spec:
 *
 * 1. The orphan flag applies to OpenBao only. A GSM secret's readers are IAM
 *    bindings this console cannot see, so `hasReader` is `null` there, never
 *    `false` — `false` would be a false alarm, drowning the real ones.
 * 2. Orphans sort to the top (then alphabetically for stability), and every
 *    count is over the whole set, not the filtered view.
 */
export function buildInventory(input: {
  openbao: string[];
  gcpsm: string[];
  grants: Grant[];
}): SecretsInventory {
  const rows: InventoryRow[] = [
    ...input.openbao.map((path) => ({
      path,
      store: "openbao" as const,
      hasReader: hasGrantFor(path, input.grants),
    })),
    // hasReader is null, not false — see the doc comment on InventoryRow.
    ...input.gcpsm.map((path) => ({ path, store: "gcpsm" as const, hasReader: null })),
  ];

  // Orphans first — the alarm has to survive a scan of a long list — then
  // alphabetically so the order is stable between loads.
  const sorted = [...rows].sort((a, b) => {
    const aOrphan = a.hasReader === false;
    const bOrphan = b.hasReader === false;
    if (aOrphan !== bOrphan) return aOrphan ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    rows: sorted,
    counts: {
      all: sorted.length,
      openbao: input.openbao.length,
      gcpsm: input.gcpsm.length,
      // Counted over the whole set, not the filtered view, and against
      // `=== false` specifically — `!hasReader` would also count every GSM
      // row, since `!null` is `true`.
      noReader: sorted.filter((r) => r.hasReader === false).length,
    },
  };
}
