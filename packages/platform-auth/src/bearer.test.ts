import { describe, expect, it } from "vitest";
import { bearerToken } from "./bearer";

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("is case-insensitive on the scheme", () => {
    expect(bearerToken("bearer xyz")).toBe("xyz");
    expect(bearerToken("BEARER xyz")).toBe("xyz");
  });
  it("trims surrounding whitespace", () => {
    expect(bearerToken("  Bearer   tok  ")).toBe("tok");
  });
  it("returns null for missing / empty / wrong scheme", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer   ")).toBeNull();
  });
});
