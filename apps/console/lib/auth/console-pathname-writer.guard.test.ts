import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CONSOLE_PATHNAME_HEADER } from "./console-pathname";

/**
 * Guard: `CONSOLE_PATHNAME_HEADER` has exactly ONE writer, and that writer
 * normalises (#547).
 *
 * # What this protects
 *
 * #543 fixed a Critical: `request.nextUrl.pathname` is not percent-decoded,
 * but Next's router hands the page the DECODED param, so `/%6Dark8ly` was
 * gated as an unknown path — the console entry capability `read`, which every
 * operator holds — while `[product]` rendered Mark8ly. The fix is
 * `consoleGatePathname`, applied in `middleware.ts` before the header is set.
 *
 * The security property therefore lives in the COMPOSITION
 * `capabilityForPath(consoleGatePathname(p))`, not in either half.
 * `console-pathname.test.ts` pins that composition's answers. What it cannot
 * see is a SECOND place setting the header — a new gate consumer forwarding a
 * raw `nextUrl.pathname` would reintroduce the bypass while every existing
 * assertion stayed green, because the layout reads whatever arrives.
 *
 * So this is a walk of the source rather than a behavioural test: the thing
 * being asserted is that no other call site exists, and only reading the tree
 * can say that.
 *
 * # Why the raw string is checked too
 *
 * A writer that spelled `"x-console-pathname"` instead of importing the
 * constant would be invisible to the constant-based check below. The literal
 * is asserted to occur in exactly one file — the module that declares it.
 *
 * # Scope
 *
 * Test and spec files are excluded. `layout.access.test.tsx` sets the header
 * to drive the gate under test, which is the point of it; a test writer cannot
 * reach a request.
 */

const CONSOLE_ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "public"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.includes(".test.") &&
      !full.includes(".spec.")
    )
      out.push(full);
  }
  return out;
}

const SOURCES = walk(CONSOLE_ROOT).map((full) => ({
  file: path.relative(CONSOLE_ROOT, full),
  source: readFileSync(full, "utf-8"),
}));

/**
 * `headers.set(CONSOLE_PATHNAME_HEADER, …)` and its `append` sibling.
 *
 * Deliberately not `/g`: a global regex carries `lastIndex` across `.test()`
 * calls, so reusing one to filter a list silently skips every other file.
 */
const WRITE = /\.(?:set|append)\(\s*CONSOLE_PATHNAME_HEADER\s*,/;

const countMatches = (source: string, pattern: RegExp) =>
  source.match(new RegExp(pattern.source, "g"))?.length ?? 0;

describe("the console pathname header has one writer", () => {
  it("scans the files the writer and the declaration live in", () => {
    // Vacuity: a walk that missed middleware.ts would pass every assertion
    // below while checking nothing that matters.
    const files = SOURCES.map((s) => s.file);

    expect(files).toContain("middleware.ts");
    expect(files).toContain(path.join("lib", "auth", "console-pathname.ts"));
  });

  it("is written from middleware.ts and nowhere else", () => {
    const writers = SOURCES.filter((s) => WRITE.test(s.source)).map((s) => s.file);

    expect(
      writers,
      "a second writer of CONSOLE_PATHNAME_HEADER is the path by which the " +
        "#543 encoding bypass returns: the gate reads whatever arrives, so a " +
        "caller forwarding a raw nextUrl.pathname re-opens it silently. Set " +
        "the header only in middleware.ts, through consoleGatePathname.",
    ).toEqual(["middleware.ts"]);
  });

  it("writes it exactly once within middleware.ts", () => {
    // A second `set` in the same file would not change the array above.
    const middleware = SOURCES.find((s) => s.file === "middleware.ts");

    expect(countMatches(middleware!.source, WRITE)).toBe(1);
  });

  it("normalises the value it writes", () => {
    const middleware = SOURCES.find((s) => s.file === "middleware.ts");

    expect(
      /\.set\(\s*CONSOLE_PATHNAME_HEADER\s*,\s*consoleGatePathname\(/.test(
        middleware!.source,
      ),
      "middleware.ts must pass the pathname through consoleGatePathname before " +
        "setting the header — see lib/auth/console-pathname.ts.",
    ).toBe(true);
  });

  it("spells the header name in one place only", () => {
    // Otherwise a writer using the literal would not be a "writer" above.
    const literal = SOURCES.filter((s) => s.source.includes(CONSOLE_PATHNAME_HEADER)).map(
      (s) => s.file,
    );

    expect(literal).toEqual([path.join("lib", "auth", "console-pathname.ts")]);
  });
});
