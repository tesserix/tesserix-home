import { describe, expect, it } from "vitest";

import { buildInventory, parseGrants, parseSecretList } from "./secrets";

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
