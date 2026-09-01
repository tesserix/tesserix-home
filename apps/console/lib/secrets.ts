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

function num(value: unknown, path: string): number {
  if (typeof value !== "number") fail(`${path} is not a number`);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return str(value, path);
}

/**
 * A string that must additionally be an `http:`/`https:` URL — for fields
 * this console later puts straight into an `<a href>` (`proposal.url`,
 * rendered by `proposals-table.tsx`). React 19 already refuses to run a
 * `javascript:` href, so this is not closing an exploitable gap; it is
 * closing an ASYMMETRY in how carefully this file treats attacker-reachable
 * fields. `proposal.url` comes from GitHub's `html_url` via `secrets-api`,
 * the same distance from this console's control as `file.patch`
 * (`proposal-view.tsx`'s `ChangedFileDiff` reasons at length about `patch`
 * being attacker-influenced) — validating the scheme here, at the same
 * boundary every other field is validated at, keeps that reasoning honest
 * rather than applying it selectively.
 */
function httpUrl(value: unknown, path: string): string {
  const url = str(value, path);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${path} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`${path} is not an http(s) URL`);
  }
  return url;
}

/**
 * Go's zero `time.Time`, serialised. `secrets.Secret.CreatedAt/UpdatedAt`
 * and `Version.CreatedAt` are `time.Time` fields tagged `json:",omitempty"`
 * — but `encoding/json`'s `omitempty` is a no-op on a struct type (it only
 * ever suppresses a value that is the zero VALUE for a small set of
 * primitive kinds — bool, numeric, string, pointer/interface/slice/map/array
 * length — and `time.Time` is none of those), so a zero timestamp still
 * serialises as this literal string rather than being omitted. It reaches
 * here as a perfectly well-formed, non-empty string, which is exactly why
 * `optionalStr` alone cannot catch it: there is nothing malformed about it
 * to reject.
 *
 * Reachable, not hypothetical: a GCPSM secret whose versions are all deleted
 * or destroyed leaves `UpdatedAt` zero (`gcpsm.Describe`'s loop that would
 * set it never fires), and `timeFrom`/`parseTime` return `time.Time{}` on
 * any absent or unparseable upstream timestamp.
 */
const ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * `optionalStr`, plus treating Go's serialised zero `time.Time` as absent.
 * See {@link ZERO_TIME} for why that string, specifically, needs its own
 * check rather than being caught by `optionalStr`'s `undefined` check.
 *
 * Fixed at THIS boundary, not in the Go service: `secrets.Secret`'s JSON
 * contract may have other readers, and "zero time serialises as a truthy
 * string" is a fact about `encoding/json`, not a bug to route around
 * upstream of every consumer.
 */
function optionalTimestamp(value: unknown, path: string): string | undefined {
  const parsed = optionalStr(value, path);
  return parsed === ZERO_TIME ? undefined : parsed;
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

/** What `buildInventory` itself can compute from listings and grants alone.
 *  It has no notion of a "walk" (that's `fetchSecretPaths`'s concept, in
 *  `secrets-api.ts`), so it cannot set `complete` — see `SecretsInventory`. */
export interface SecretsInventoryData {
  readonly rows: readonly InventoryRow[];
  readonly counts: {
    readonly all: number;
    readonly openbao: number;
    readonly gcpsm: number;
    readonly noReader: number;
  };
}

/**
 * The full inventory a page renders: `SecretsInventoryData` plus whether the
 * walks that produced it actually reached every leaf.
 *
 * `complete` is composed at the fetch layer (`fetchSecretsInventory`), not
 * here: `buildInventory` is handed plain path arrays and never sees a
 * `SecretWalkResult`, so it has nothing to compose it from. It is `true`
 * only if every store that was walked reported `complete` — one truncated
 * store must make the whole inventory incomplete, because this surface's job
 * is to say what's missing, and a silently-partial "complete" would turn a
 * missing row back into a false all-clear.
 */
export interface SecretsInventory extends SecretsInventoryData {
  readonly complete: boolean;
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
 * Every grant that covers the secret at `path` — the "who can read this"
 * answer the access card (Task 4) renders, and the one prefix rule
 * `hasGrantFor` also needs. Extracted so there is exactly one definition of
 * "covers"; `hasGrantFor` below calls this rather than re-implementing it.
 *
 * A grant covers its own prefix (`namespace/app`) and everything beneath it
 * (`namespace/app/...`). The trailing slash on the "beneath" check is load
 * bearing: without it, a grant for app `api` would also match `api-internal`,
 * claiming a reader that does not exist.
 */
export function readersFor(path: string, grants: readonly Grant[]): Grant[] {
  return grants.filter((g) => {
    const prefix = `${g.namespace}/${g.app}`;
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/** Does some grant give a reader to the secret at `path`? See {@link readersFor}. */
function hasGrantFor(path: string, grants: readonly Grant[]): boolean {
  return readersFor(path, grants).length > 0;
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
}): SecretsInventoryData {
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

/**
 * A secret's shape: `secrets-api`'s `Store` interface has no `Read` method
 * (the design spec says why: "so no handler can leak one"), so nothing this
 * console can fetch ever carries a value. `keys` is a list of key NAMES.
 *
 * Do not add a `value` field here, ever — see `parseSecretDetail`.
 */
export interface SecretDetail {
  readonly path: string;
  readonly version: number;
  readonly keys: string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** One version in a secret's history. */
export interface SecretVersion {
  readonly version: number;
  readonly createdAt?: string;
  readonly destroyed: boolean;
  readonly deleted: boolean;
}

/**
 * Parse `GET /api/secrets/*path`'s response — the bare `secrets.Secret`
 * struct, not wrapped in an envelope — into a `SecretDetail`.
 *
 * Built field by field from known keys, never by spreading `json`: a spread
 * would carry forward any field the input happens to have, including one
 * shaped like a secret value if the service ever grew a way to return one.
 * The console has no legitimate use for a value and must never be able to
 * hold one in a type a UI could render — see `SecretDetail`'s doc comment.
 */
export function parseSecretDetail(json: unknown): SecretDetail {
  if (!isRecord(json)) fail("response is not an object");
  return {
    path: str(json.path, "path"),
    version: num(json.version, "version"),
    keys: Array.isArray(json.keys)
      ? json.keys.map((k, i) => str(k, `keys[${i}]`))
      : fail("keys is not an array"),
    createdAt: optionalTimestamp(json.createdAt, "createdAt"),
    updatedAt: optionalTimestamp(json.updatedAt, "updatedAt"),
  };
}

/**
 * Parse `GET /api/secret-versions/*path`'s response
 * (`{"path":…,"versions":[…]}`) into its version list.
 */
export function parseSecretVersions(json: unknown): SecretVersion[] {
  if (!isRecord(json)) fail("response is not an object");
  if (!Array.isArray(json.versions)) fail("versions is not an array");
  return json.versions.map((v, i) => {
    if (!isRecord(v)) fail(`versions[${i}] is not an object`);
    return {
      version: num(v.version, `versions[${i}].version`),
      createdAt: optionalTimestamp(v.createdAt, `versions[${i}].createdAt`),
      destroyed: bool(v.destroyed, `versions[${i}].destroyed`),
      deleted: bool(v.deleted, `versions[${i}].deleted`),
    };
  });
}

/**
 * A console-raised change awaiting review: one entry in `gitops.PullRequest`
 * (`secrets-api/internal/gitops/review.go`).
 *
 * `createdAt` is optional for the same reason `SecretDetail.createdAt` is:
 * `PullRequest.CreatedAt` is a `time.Time` with no `omitempty` that would do
 * anything (see `ZERO_TIME`'s doc comment) — but here the trigger is not a
 * store quirk, it's `toPullRequest` discarding `time.Parse`'s error
 * (`review.go:61`, `created, _ := time.Parse(...)`), so ANY GitHub
 * timestamp this service fails to parse becomes the zero time and reaches
 * this parser as the literal `ZERO_TIME` string. `optionalTimestamp` is
 * reused rather than re-implemented for exactly that string.
 *
 * `targets` is `string[]`, never `string[] | undefined` or nullable, even
 * though the Go field can serialise as JSON `null` (`parseTargets` returns a
 * nil slice when the PR body has no target trailer, and a nil `[]string`
 * with no `omitempty`-relevant zero-value exemption for slices still writes
 * `null`). The parser below normalises `null` to `[]` at this boundary so
 * every caller can iterate `targets` unconditionally.
 */
export interface Proposal {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly author: string;
  readonly createdAt?: string;
  readonly targets: string[];
}

/** One file changed by a proposal: `gitops.ChangedFile`. */
export interface ChangedFile {
  readonly filename: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/**
 * A proposal plus what an administrator needs to decide on it:
 * `gitops.PullDetail`, which embeds `PullRequest` and adds three fields.
 *
 * `files`, like `targets` above, is declared `var files []ChangedFile` in
 * `gitops.Pull` (`review.go`) — a plain nil-able slice — so a proposal that
 * changed nothing GitHub reports as files (it never does in practice, but
 * the wire shape doesn't know that) serialises as JSON `null`, not `[]`.
 * `approvals`, by contrast, is built with `make([]string, 0, len(reviews))`
 * in the same function, so it is ALWAYS a JSON array, never `null` — do not
 * add a null-guard for it that mirrors `files`'s; there is nothing on the
 * wire for it to guard against, and doing so would hide a genuine shape
 * violation (a non-array `approvals`) behind a silent default instead of
 * throwing.
 */
export interface ProposalDetail extends Proposal {
  readonly mergeableState: string;
  readonly approvals: string[];
  readonly files: ChangedFile[];
}

/**
 * An array field that the Go source declares as a plain `var …[]T` (never
 * `make`d), so an empty result serialises as JSON `null` rather than `[]`.
 * Reused by both `parseProposals` (for `targets`) and `parseProposalDetail`
 * (for `targets` and `files`) — see their doc comments for which Go fields
 * this applies to and, just as importantly, which one (`approvals`) it does
 * NOT apply to.
 *
 * `null` and an absent key are treated the same way (both hit the `?? null`
 * default), but a present value that is neither `null` nor an array is
 * rejected — a nullable array is not the same contract as "anything goes".
 */
function nullableArray<T>(value: unknown, path: string, parseItem: (item: unknown, itemPath: string) => T): T[] {
  const v = value ?? null;
  if (v === null) return [];
  if (!Array.isArray(v)) fail(`${path} is not an array or null`);
  return v.map((item, i) => parseItem(item, `${path}[${i}]`));
}

function parseProposalFields(entry: Record<string, unknown>, prefix: string): Proposal {
  return {
    number: num(entry.number, `${prefix}number`),
    title: str(entry.title, `${prefix}title`),
    url: httpUrl(entry.url, `${prefix}url`),
    branch: str(entry.branch, `${prefix}branch`),
    author: str(entry.author, `${prefix}author`),
    createdAt: optionalTimestamp(entry.createdAt, `${prefix}createdAt`),
    targets: nullableArray(entry.targets, `${prefix}targets`, (item, itemPath) => str(item, itemPath)),
  };
}

/**
 * Parse `GET /api/reviews`'s response (`{"pulls":[…]}`) into its proposal
 * list.
 */
export function parseProposals(json: unknown): Proposal[] {
  if (!isRecord(json)) fail("response is not an object");
  if (!Array.isArray(json.pulls)) fail("pulls is not an array");
  return json.pulls.map((entry, i) => {
    if (!isRecord(entry)) fail(`pulls[${i}] is not an object`);
    return parseProposalFields(entry, `pulls[${i}].`);
  });
}

/**
 * Parse `GET /api/reviews/:number`'s response into a `ProposalDetail`.
 *
 * The response is the bare `gitops.PullDetail` struct, not wrapped in an
 * envelope (`c.JSON(http.StatusOK, detail)` in
 * `secrets-api/internal/api/handlers/reviews.go:67`) — unlike `parseProposals`
 * above, there is no `{"pull":…}` key to unwrap first.
 */
export function parseProposalDetail(json: unknown): ProposalDetail {
  if (!isRecord(json)) fail("response is not an object");
  return {
    ...parseProposalFields(json, ""),
    mergeableState: str(json.mergeableState, "mergeableState"),
    approvals: Array.isArray(json.approvals)
      ? json.approvals.map((a, i) => str(a, `approvals[${i}]`))
      : fail("approvals is not an array"),
    files: nullableArray(json.files, "files", (file, filePath) => {
      if (!isRecord(file)) fail(`${filePath} is not an object`);
      return {
        filename: str(file.filename, `${filePath}.filename`),
        additions: num(file.additions, `${filePath}.additions`),
        deletions: num(file.deletions, `${filePath}.deletions`),
        patch: str(file.patch, `${filePath}.patch`),
      };
    }),
  };
}
