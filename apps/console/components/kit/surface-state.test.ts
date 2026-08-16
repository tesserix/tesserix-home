import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED, resolveState, toSurfaceError } from "./surface-state";

const SOURCE = join(import.meta.dirname, "surface-state.ts");

/**
 * The reason this module exists at all is that server components must be able
 * to call `resolveState`. `use-client-boundary.test.ts` guards the opposite
 * direction — that anything importing `@tesserix/web` declares the directive —
 * and only globs `.tsx`, so this file is not covered by it.
 */
describe("surface-state stays callable from a server component", () => {
  const source = readFileSync(SOURCE, "utf8");

  it("finds the module it is checking", () => {
    // Guards the guard: a wrong path would make both assertions below vacuous.
    expect(source).toContain("export function resolveState");
  });

  it("declares no 'use client' directive", () => {
    // A directive here turns every export into a client reference, and
    // `resolveState(...)` on the server throws "Attempted to call
    // resolveState() from the server but it's on the client."
    const firstStatement = source
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"),
      )[0];
    expect(firstStatement).not.toMatch(/^["']use client["'];?$/);
  });

  it("imports neither React nor the design system", () => {
    // Either import would drag the client boundary back in.
    expect(source).not.toMatch(/from ["']@tesserix\/web["']/);
    expect(source).not.toMatch(/from ["']react["']/);
  });
});

describe("toSurfaceError", () => {
  it("preserves the status so a 501 is still distinguishable", () => {
    const parked = Object.assign(new Error("parked"), { status: NOT_IMPLEMENTED });
    expect(toSurfaceError(parked)).toEqual({ status: NOT_IMPLEMENTED, message: "parked" });
  });

  it("treats null and undefined as no error at all", () => {
    expect(toSurfaceError(null)).toBeNull();
    expect(toSurfaceError(undefined)).toBeNull();
  });

  it("carries an Error with no status through without inventing one", () => {
    expect(toSurfaceError(new Error("ECONNREFUSED"))).toEqual({
      status: undefined,
      message: "ECONNREFUSED",
    });
  });

  it("never puts [object Object] in front of an operator", () => {
    const surfaced = toSurfaceError({ nope: true });
    expect(surfaced?.message).not.toContain("[object Object]");
    expect(surfaced?.message).toBeTruthy();
  });

  it("formats a non-Error rejection rather than dropping it", () => {
    expect(toSurfaceError("boom")).toEqual({ message: "boom" });
  });
});

describe("resolveState with a narrowed error", () => {
  it("keeps a 501 out of the error state end to end", () => {
    const parked = Object.assign(new Error("parked"), { status: NOT_IMPLEMENTED });
    expect(
      resolveState({ isLoading: false, error: toSurfaceError(parked), rows: [], filtered: false }),
    ).toEqual({ kind: "instrumentation-unavailable" });
  });
});
