import { describe, expect, it } from "vitest";

import { parseEstateTenants, splitTenantId } from "./tenants";

const row = {
  id: "mark8ly:t1",
  name: "Acme",
  owner_email: "a@x.test",
  status: "active",
  created_at: "2026-08-12T09:31:00Z",
  source: "mark8ly",
};

const body = { tenants: [row], failures: [] };

describe("parseEstateTenants", () => {
  it("maps the wire shape onto the console's row", () => {
    const parsed = parseEstateTenants(body);
    expect(parsed.tenants[0]).toEqual({
      id: "mark8ly:t1",
      name: "Acme",
      ownerEmail: "a@x.test",
      status: "active",
      createdAt: "2026-08-12T09:31:00Z",
      source: "mark8ly",
    });
  });

  it("accepts a row without the optional fields", () => {
    const { owner_email: _o, created_at: _c, ...bare } = row;
    const parsed = parseEstateTenants({ tenants: [bare], failures: [] });
    expect(parsed.tenants[0].ownerEmail).toBeUndefined();
    expect(parsed.tenants[0].createdAt).toBeUndefined();
  });

  // A renamed field upstream must be a failure, not a blank column. Only the
  // second kind of bug gets fixed.
  it.each(["id", "name", "status", "source"])("throws when %s is missing", (field) => {
    const broken = { ...row, [field]: undefined };
    expect(() => parseEstateTenants({ tenants: [broken], failures: [] })).toThrow(
      new RegExp(field),
    );
  });

  // Asserting completeness this surface cannot verify is the one claim a
  // directory must never make by accident.
  it("requires failures rather than defaulting it to empty", () => {
    expect(() => parseEstateTenants({ tenants: [] })).toThrow(/failures/);
  });

  it("parses a reported failure", () => {
    const parsed = parseEstateTenants({
      tenants: [],
      failures: [{ source: "kora", message: "responded 503" }],
    });
    expect(parsed.failures[0]).toEqual({ source: "kora", message: "responded 503" });
  });

  it.each([null, [], "nope", 42])("throws on a body that is %s", (bad) => {
    expect(() => parseEstateTenants(bad)).toThrow();
  });

  it("names the row index in the error so a bad row is findable", () => {
    expect(() =>
      parseEstateTenants({ tenants: [row, { ...row, name: 7 }], failures: [] }),
    ).toThrow(/tenants\[1\]\.name/);
  });
});

describe("splitTenantId", () => {
  it("splits a namespaced id", () => {
    expect(splitTenantId("mark8ly:t1")).toEqual({ source: "mark8ly", productId: "t1" });
  });

  // The product's own id may contain a colon; splitting on the last separator
  // would silently reattribute those rows to the wrong product.
  it("splits on the FIRST separator only", () => {
    expect(splitTenantId("mark8ly:store:42")).toEqual({
      source: "mark8ly",
      productId: "store:42",
    });
  });

  it("reports no source when the id was never namespaced", () => {
    expect(splitTenantId("t1")).toEqual({ source: "", productId: "t1" });
  });
});
