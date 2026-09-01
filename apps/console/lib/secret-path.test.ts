import { describe, expect, it } from "vitest";
import { validateSecretPathForCreate } from "@/lib/secret-path";
import type { SecretStore } from "@/lib/secrets";

const STORES: readonly SecretStore[] = ["openbao", "gcpsm"];

describe("validateSecretPathForCreate", () => {
  it("accepts a well-formed 3-segment path for both stores", () => {
    for (const store of STORES) {
      const result = validateSecretPathForCreate("a/b/c", store);
      expect(result).toEqual({ ok: true, cleaned: "a/b/c" });
    }
  });

  it("rejects a path shallower than <namespace>/<app>/<name>", () => {
    const result = validateSecretPathForCreate("a/b", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at least 3 segments/);
  });

  it("accepts a 4-segment path — name may itself contain a slash", () => {
    const result = validateSecretPathForCreate("a/b/c/d", "openbao");
    expect(result).toEqual({ ok: true, cleaned: "a/b/c/d" });
  });

  it("rejects an uppercase namespace, naming the namespace rule and segment", () => {
    const result = validateSecretPathForCreate("A/b/c", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Namespace");
      expect(result.message).toContain('"A"');
      expect(result.message).toMatch(/lowercase/);
    }
  });

  it("accepts a lowercase namespace as a near-miss of the uppercase rejection", () => {
    const result = validateSecretPathForCreate("a/b/c", "openbao");
    expect(result).toEqual({ ok: true, cleaned: "a/b/c" });
  });

  it("rejects an uppercase app, naming the app rule and segment", () => {
    const result = validateSecretPathForCreate("a/B/c", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("App");
      expect(result.message).toContain('"B"');
      expect(result.message).toMatch(/lowercase/);
    }
  });

  it("rejects a percent-encoded segment", () => {
    const result = validateSecretPathForCreate("a/b/c%2f", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/percent-encoded/);
      expect(result.message).toContain('"c%2f"');
    }
  });

  it("rejects a traversal segment", () => {
    const result = validateSecretPathForCreate("a/../c", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('".."');
  });

  it("cleans doubled slashes rather than rejecting them", () => {
    const result = validateSecretPathForCreate("a//b/c", "openbao");
    expect(result).toEqual({ ok: true, cleaned: "a/b/c" });
  });

  it("rejects a path over 512 characters", () => {
    const result = validateSecretPathForCreate("a".repeat(513), "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/512 characters/);
  });

  it("accepts a path at exactly 512 characters as a near-miss of the length rejection", () => {
    // 512 'a's has no '/', so it is a single segment and fails arity — but it
    // must fail on segment count, never on length, proving the boundary is
    // "greater than 512", not "at least 512".
    const result = validateSecretPathForCreate("a".repeat(512), "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toMatch(/512 characters/);
  });

  it("accepts a dotted name segment for openbao", () => {
    const result = validateSecretPathForCreate("a/b/c.d", "openbao");
    expect(result).toEqual({ ok: true, cleaned: "a/b/c.d" });
  });

  it("rejects a dotted name segment for gcpsm", () => {
    const result = validateSecretPathForCreate("a/b/c.d", "gcpsm");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Google Secret Manager/);
      expect(result.message).toContain('"c.d"');
    }
  });

  it("rejects a backslash anywhere in the path", () => {
    const result = validateSecretPathForCreate("a/b\\c/d", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/backslash/);
  });

  it("rejects an empty path", () => {
    const result = validateSecretPathForCreate("   ", "openbao");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/empty/);
  });
});
