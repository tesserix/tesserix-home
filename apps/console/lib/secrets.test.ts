import { describe, expect, it } from "vitest";

import {
  buildInventory,
  parseGrants,
  parseProposalDetail,
  parseProposals,
  parseSecretDetail,
  parseSecretList,
  parseSecretVersions,
  readersFor,
} from "./secrets";

describe("parseSecretList", () => {
  it("reads the entries array", () => {
    expect(parseSecretList({ prefix: "/", entries: [{ name: "db", isFolder: true }] })).toEqual([
      { name: "db", isFolder: true },
    ]);
  });

  it("rejects a response that is not shaped like a listing", () => {
    expect(() => parseSecretList({ entries: "nope" })).toThrow();
    expect(() => parseSecretList(null)).toThrow();
  });

  // Absent isFolder must not silently become `false` — a folder treated as a
  // secret would be listed as one and then fail to describe.
  it("rejects an entry missing isFolder", () => {
    expect(() => parseSecretList({ entries: [{ name: "db" }] })).toThrow();
  });

  // This is the boundary parser every walk of the tree passes through, and
  // the namespace/app matching downstream assumes each path segment is
  // exactly one entry's name — a "/" inside a name would silently cross that
  // boundary and either merge or split a segment nobody asked for.
  it("rejects an entry whose name contains a slash", () => {
    expect(() => parseSecretList({ entries: [{ name: "a/b", isFolder: false }] })).toThrow();
  });

  // An empty name composes into a path with a missing segment (or a bare
  // trailing slash), which is exactly as unmatchable against a grant prefix
  // as a slash-containing one — and just as silent about it.
  it("rejects an entry with an empty name", () => {
    expect(() => parseSecretList({ entries: [{ name: "", isFolder: false }] })).toThrow();
  });
});

describe("parseGrants", () => {
  it("reads the grants array, keeping only namespace and app", () => {
    expect(
      parseGrants({
        grants: [
          {
            namespace: "homechef",
            app: "homechef-api",
            serviceAccount: "sa",
            secretPrefix: "kv/homechef/homechef-api",
          },
        ],
      }),
    ).toEqual([{ namespace: "homechef", app: "homechef-api" }]);
  });

  it("rejects a response that is not shaped like a grants list", () => {
    expect(() => parseGrants({ grants: "nope" })).toThrow();
    expect(() => parseGrants(null)).toThrow();
  });

  it("rejects a grant missing namespace or app", () => {
    expect(() => parseGrants({ grants: [{ namespace: "homechef" }] })).toThrow();
    expect(() => parseGrants({ grants: [{ app: "homechef-api" }] })).toThrow();
  });

  it("rejects a grant with an empty namespace or app", () => {
    expect(() => parseGrants({ grants: [{ namespace: "", app: "homechef-api" }] })).toThrow();
    expect(() => parseGrants({ grants: [{ namespace: "homechef", app: "" }] })).toThrow();
  });
});

describe("buildInventory", () => {
  const base = { openbao: ["mark8ly/db"], gcpsm: [], grants: [] };

  it("flags an OpenBao secret with no grant as having no reader", () => {
    const { rows } = buildInventory(base);
    expect(rows).toEqual([{ path: "mark8ly/db", store: "openbao", hasReader: false }]);
  });

  it("does not flag an OpenBao secret that has a grant", () => {
    const { rows } = buildInventory({
      ...base,
      grants: [{ namespace: "mark8ly", app: "db" }],
    });
    expect(rows[0].hasReader).toBe(true);
  });

  it("does not flag an OpenBao secret nested under a granted app prefix", () => {
    const { rows } = buildInventory({
      openbao: ["mark8ly/api/db-password"],
      gcpsm: [],
      grants: [{ namespace: "mark8ly", app: "api" }],
    });
    expect(rows[0].hasReader).toBe(true);
  });

  // The rule that a naive implementation gets wrong. GSM readers are IAM
  // bindings the console cannot see, so "no reader" is unknowable, not false.
  it("never flags a Google Secret Manager secret, even with no grants", () => {
    const { rows } = buildInventory({ openbao: [], gcpsm: ["stripe/key"], grants: [] });
    expect(rows[0]).toEqual({ path: "stripe/key", store: "gcpsm", hasReader: null });
  });

  it("counts only OpenBao orphans as noReader", () => {
    const { counts } = buildInventory({
      openbao: ["a/x", "b/y"],
      gcpsm: ["c", "d", "e"],
      grants: [{ namespace: "a", app: "x" }],
    });
    expect(counts).toEqual({ all: 5, openbao: 2, gcpsm: 3, noReader: 1 });
  });

  it("sorts orphans to the top, then by path", () => {
    const { rows } = buildInventory({
      openbao: ["zed/z", "alpha/a", "beta/b"],
      gcpsm: [],
      grants: [{ namespace: "alpha", app: "a" }, { namespace: "zed", app: "z" }],
    });
    expect(rows.map((r) => r.path)).toEqual(["beta/b", "alpha/a", "zed/z"]);
  });

  it("treats a grant as covering everything beneath its prefix", () => {
    const { rows } = buildInventory({
      openbao: ["homechef/homechef-api/db-password"],
      gcpsm: [],
      grants: [{ namespace: "homechef", app: "homechef-api" }],
    });
    expect(rows[0].hasReader).toBe(true);
  });

  // Without the trailing slash on the prefix comparison, a grant for `api`
  // would silently cover `api-internal`, claiming a reader that does not exist.
  it("does not let a grant leak into a sibling with a longer name", () => {
    const { rows } = buildInventory({
      openbao: ["homechef/api-internal/token"],
      gcpsm: [],
      grants: [{ namespace: "homechef", app: "api" }],
    });
    expect(rows[0].hasReader).toBe(false);
  });

  it("covers the secret sitting exactly at the grant prefix", () => {
    const { rows } = buildInventory({
      openbao: ["homechef/homechef-api"],
      gcpsm: [],
      grants: [{ namespace: "homechef", app: "homechef-api" }],
    });
    expect(rows[0].hasReader).toBe(true);
  });
});

describe("readersFor", () => {
  it("returns the grant sitting exactly at the path", () => {
    const grant = { namespace: "homechef", app: "homechef-api" };
    expect(readersFor("homechef/homechef-api", [grant])).toEqual([grant]);
  });

  it("returns a grant on a parent prefix", () => {
    const grant = { namespace: "homechef", app: "homechef-api" };
    expect(readersFor("homechef/homechef-api/db-password", [grant])).toEqual([grant]);
  });

  // The same trailing-slash rule `hasGrantFor`'s doc comment names: without
  // it, a grant for `api` would also match `api-internal`, claiming a reader
  // that does not exist.
  it("does not let a grant on 'api' cover 'api-internal'", () => {
    const grant = { namespace: "namespace", app: "api" };
    expect(readersFor("namespace/api-internal", [grant])).toEqual([]);
  });

  it("returns every grant covering the path when more than one does", () => {
    // Two independent prefixes that both happen to cover the same secret —
    // a grant on the app itself, and a (namespace-shaped) grant one level up.
    const onApp = { namespace: "homechef", app: "homechef-api" };
    const onParent = { namespace: "homechef", app: "homechef-api/nested" };
    const path = "homechef/homechef-api/nested/db-password";
    expect(readersFor(path, [onApp, onParent, { namespace: "other", app: "x" }])).toEqual([onApp, onParent]);
  });

  it("returns an empty array when no grant covers the path", () => {
    expect(readersFor("homechef/homechef-api", [{ namespace: "other", app: "x" }])).toEqual([]);
    expect(readersFor("homechef/homechef-api", [])).toEqual([]);
  });
});

describe("parseSecretDetail", () => {
  it("reads a secret's shape", () => {
    expect(parseSecretDetail({ path: "a/b/c", version: 3, keys: ["password"] })).toMatchObject({
      path: "a/b/c",
      version: 3,
      keys: ["password"],
    });
  });

  it("rejects a detail with a non-numeric version", () => {
    expect(() => parseSecretDetail({ path: "a/b/c", version: "3", keys: [] })).toThrow();
  });

  // A response carrying a value would mean the service grew an endpoint that
  // returns one. Parse it out rather than passing it along: the console has no
  // legitimate use for it, and a type that can hold one invites a UI that shows it.
  it("ignores any value-shaped field rather than surfacing it", () => {
    const parsed = parseSecretDetail({
      path: "a/b",
      version: 1,
      keys: ["k"],
      data: { k: "hunter2" },
    }) as unknown as Record<string, unknown>;
    expect(parsed.data).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  // Go's `encoding/json` `omitempty` is a no-op on a `time.Time` struct
  // field, so `secrets.Secret.CreatedAt`/`UpdatedAt` — both `time.Time`,
  // tagged `json:",omitempty"` — serialise their zero value as this literal
  // string rather than omitting the key. This is the shape the server
  // ACTUALLY produces for a GCPSM secret whose versions are all deleted or
  // destroyed (`gcpsm.Describe`'s loop that would set `UpdatedAt` never
  // fires) — present-but-zero, never an omitted key, which is why a fixture
  // that omits `createdAt`/`updatedAt` entirely (as this suite used to)
  // cannot catch the bug: real absence and real zero look identical only if
  // you never construct the zero case.
  it("treats Go's serialised zero time.Time as absent, not as a real timestamp", () => {
    const parsed = parseSecretDetail({
      path: "a/b",
      version: 1,
      keys: ["k"],
      createdAt: "0001-01-01T00:00:00Z",
      updatedAt: "0001-01-01T00:00:00Z",
    });
    expect(parsed.createdAt).toBeUndefined();
    expect(parsed.updatedAt).toBeUndefined();
  });

  it("still passes through a real timestamp", () => {
    const parsed = parseSecretDetail({
      path: "a/b",
      version: 1,
      keys: ["k"],
      createdAt: "2026-08-01T12:00:00Z",
      updatedAt: "2026-08-30T09:30:00Z",
    });
    expect(parsed.createdAt).toBe("2026-08-01T12:00:00Z");
    expect(parsed.updatedAt).toBe("2026-08-30T09:30:00Z");
  });
});

describe("parseSecretVersions", () => {
  it("reads versions, preserving destroyed and deleted", () => {
    expect(parseSecretVersions({ versions: [{ version: 2, destroyed: false, deleted: true }] })).toEqual([
      { version: 2, destroyed: false, deleted: true, createdAt: undefined },
    ]);
  });

  // Same server-shape fact as `parseSecretDetail` above: `Version.CreatedAt`
  // is also a `time.Time` with a no-op `omitempty`, so a version whose
  // timestamp was never recorded arrives as the zero-time string, present,
  // not an omitted key.
  it("treats a present-but-zero createdAt the same as absent", () => {
    expect(
      parseSecretVersions({
        versions: [{ version: 1, createdAt: "0001-01-01T00:00:00Z", destroyed: false, deleted: false }],
      }),
    ).toEqual([{ version: 1, createdAt: undefined, destroyed: false, deleted: false }]);
  });

  it("rejects a versions response that is not a list", () => {
    expect(() => parseSecretVersions({ versions: "nope" })).toThrow();
  });
});

describe("parseProposals", () => {
  const pull = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    title: "grant homechef reader access",
    url: "https://github.com/tesserix/tesserix-k8s/pull/42",
    branch: "console/homechef-homechef-api-grant",
    author: "console-bot",
    createdAt: "2026-08-30T09:30:00Z",
    targets: ["homechef/homechef-api"],
    ...overrides,
  });

  it("reads the pulls array", () => {
    expect(parseProposals({ pulls: [pull()] })).toEqual([
      {
        number: 42,
        title: "grant homechef reader access",
        url: "https://github.com/tesserix/tesserix-k8s/pull/42",
        branch: "console/homechef-homechef-api-grant",
        author: "console-bot",
        createdAt: "2026-08-30T09:30:00Z",
        targets: ["homechef/homechef-api"],
      },
    ]);
  });

  // THE trap: `gitops/review.go:61` discards `time.Parse`'s error
  // (`created, _ := time.Parse(...)`), so any GitHub timestamp the service
  // fails to parse becomes the zero time and reaches this parser as this
  // literal, non-empty, well-formed string — reused check, see `secrets.ts`'s
  // `ZERO_TIME` doc comment for why `optionalStr` alone cannot catch it.
  it("treats a zero-time createdAt as absent", () => {
    const parsed = parseProposals({ pulls: [pull({ createdAt: "0001-01-01T00:00:00Z" })] });
    expect(parsed[0]?.createdAt).toBeUndefined();
  });

  // `targets` comes from `var files []ChangedFile`-style plain slices in the
  // Go source (`parseTargets` returns nil when the PR body has no target
  // trailer), so it serialises as JSON `null`, not `[]`, when empty.
  it("normalises a null targets to an empty array", () => {
    const parsed = parseProposals({ pulls: [pull({ targets: null })] });
    expect(parsed[0]?.targets).toEqual([]);
  });

  it("rejects a response that is not shaped like a pull list", () => {
    expect(() => parseProposals({ pulls: "nope" })).toThrow();
    expect(() => parseProposals(null)).toThrow();
  });

  it("rejects a malformed entry rather than defaulting", () => {
    expect(() => parseProposals({ pulls: [pull({ number: "42" })] })).toThrow();
    expect(() => parseProposals({ pulls: [pull({ title: undefined })] })).toThrow();
  });

  // `proposal.url` goes straight into an `<a href>` (`proposals-table.tsx`),
  // so its scheme is validated at the same parser boundary every other
  // field is, closing the asymmetry with `patch`'s attacker-influenced-input
  // reasoning in the same file.
  it("rejects a url with a non-http(s) scheme", () => {
    expect(() =>
      parseProposals({ pulls: [pull({ url: "javascript:alert(1)" })] }),
    ).toThrow();
  });

  it("rejects a url that is not a valid URL at all", () => {
    expect(() => parseProposals({ pulls: [pull({ url: "not a url" })] })).toThrow();
  });

  it("accepts an http(s) url", () => {
    const parsed = parseProposals({ pulls: [pull({ url: "http://github.com/x/y/pull/1" })] });
    expect(parsed[0]?.url).toBe("http://github.com/x/y/pull/1");
  });

  it("reads requestedBy and mergedAt off a merged proposal", () => {
    const [p] = parseProposals({
      pulls: [
        pull({ number: 4, author: "bot", requestedBy: "subject-9", mergedAt: "2026-09-01T10:00:00Z" }),
      ],
    });
    expect(p?.requestedBy).toBe("subject-9");
    expect(p?.mergedAt).toBe("2026-09-01T10:00:00Z");
  });

  it("leaves requestedBy undefined on a proposal raised before the trailer existed", () => {
    const [p] = parseProposals({ pulls: [pull({ number: 5, author: "bot" })] });
    expect(p?.requestedBy).toBeUndefined();
  });

  // `requested-by:` is a trailer added after some proposals already existed
  // — an old proposal serialises the field as `""`, not an absent key, and
  // `""` must never become a value a recipient filter could match.
  it("treats an empty requestedBy as absent, not an empty string", () => {
    const [p] = parseProposals({ pulls: [pull({ requestedBy: "" })] });
    expect(p?.requestedBy).toBeUndefined();
  });

  // Absence is legal, a wrong TYPE is not — a drifted upstream sending a
  // number must surface as a parse failure, not silently read as "absent".
  it("rejects a non-string requestedBy rather than treating it as absent", () => {
    expect(() => parseProposals({ pulls: [pull({ requestedBy: 123 })] })).toThrow();
  });

  // Defense-in-depth: Go's `trailerValue` already `TrimSpace`s when
  // reading the trailer back, so this shouldn't be reachable from a
  // correctly-behaving upstream, but a field that gates "may operator A see
  // operator B's activity" should not treat whitespace as a real value.
  it("treats a whitespace-only requestedBy as absent", () => {
    const [p] = parseProposals({ pulls: [pull({ requestedBy: "   " })] });
    expect(p?.requestedBy).toBeUndefined();
  });

  // Same fact as `createdAt`'s zero-time trap above, but for `mergedAt`:
  // `PullRequest.MergedAt` is a `time.Time`, not a pointer, so an open
  // proposal (never merged) still serialises this field as Go's zero time
  // rather than omitting it.
  it("treats a zero-time mergedAt as absent", () => {
    const [p] = parseProposals({ pulls: [pull({ mergedAt: "0001-01-01T00:00:00Z" })] });
    expect(p?.mergedAt).toBeUndefined();
  });
});

describe("parseProposalDetail", () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    title: "grant homechef reader access",
    url: "https://github.com/tesserix/tesserix-k8s/pull/42",
    branch: "console/homechef-homechef-api-grant",
    author: "console-bot",
    createdAt: "2026-08-30T09:30:00Z",
    targets: ["homechef/homechef-api"],
    mergeableState: "clean",
    approvals: ["reviewer-one"],
    files: [{ filename: "apps/homechef/rbac.yaml", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@" }],
    ...overrides,
  });

  // The handler returns the bare struct (`c.JSON(http.StatusOK, detail)`),
  // never wrapped in an envelope — unlike `GET /api/reviews`'s `{"pulls":…}`.
  it("reads a bare (unwrapped) detail response", () => {
    expect(parseProposalDetail(detail())).toEqual({
      number: 42,
      title: "grant homechef reader access",
      url: "https://github.com/tesserix/tesserix-k8s/pull/42",
      branch: "console/homechef-homechef-api-grant",
      author: "console-bot",
      createdAt: "2026-08-30T09:30:00Z",
      targets: ["homechef/homechef-api"],
      mergeableState: "clean",
      approvals: ["reviewer-one"],
      files: [{ filename: "apps/homechef/rbac.yaml", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@" }],
    });
  });

  it("treats a zero-time createdAt as absent", () => {
    const parsed = parseProposalDetail(detail({ createdAt: "0001-01-01T00:00:00Z" }));
    expect(parsed.createdAt).toBeUndefined();
  });

  // `files` is `var files []ChangedFile` in `gitops.Pull` — a plain nil-able
  // slice, so an empty result serialises as JSON `null`.
  it("normalises a null files to an empty array", () => {
    const parsed = parseProposalDetail(detail({ files: null }));
    expect(parsed.files).toEqual([]);
  });

  // Same fact as `parseProposals`'s equivalent test, but on the detail's own
  // `targets` field.
  it("normalises a null targets to an empty array", () => {
    const parsed = parseProposalDetail(detail({ targets: null }));
    expect(parsed.targets).toEqual([]);
  });

  // `approvals` is built with `make([]string, 0, len(reviews))` — always a
  // JSON array, never `null`. A `null` here is a genuine shape violation,
  // not the same "empty vs absent" case `files`/`targets` legitimately hit,
  // so it must throw rather than being silently defaulted to `[]`.
  it("rejects a null approvals rather than defaulting it", () => {
    expect(() => parseProposalDetail(detail({ approvals: null }))).toThrow();
  });

  it("rejects a response that is not shaped like a detail", () => {
    expect(() => parseProposalDetail("nope")).toThrow();
    expect(() => parseProposalDetail(null)).toThrow();
  });

  it("rejects a malformed file entry rather than defaulting", () => {
    expect(() =>
      parseProposalDetail(detail({ files: [{ filename: "a", additions: "3", deletions: 0, patch: "" }] })),
    ).toThrow();
  });
});
