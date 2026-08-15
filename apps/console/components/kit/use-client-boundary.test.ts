import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `@tesserix/web`'s barrel is itself a `"use client"` module. Importing it from
 * a React Server Component yields `undefined` for every export, and React fails
 * at render with "Element type is invalid ... got: undefined".
 *
 * Nothing else catches this: `tsc` reads the .d.ts and is satisfied, `next
 * build` succeeds, and jsdom component tests pass because they render on the
 * client where the imports resolve fine. It reached production, where the
 * authenticated dashboard 500'd on every request while the login gate — which
 * renders no kit component — looked healthy.
 *
 * So the invariant is checked from the file text: any module importing
 * `@tesserix/web` must declare `"use client"`. Several of these components use
 * no hooks, which is exactly why the directive gets forgotten.
 */
const KIT_DIR = join(import.meta.dirname);
const NAV_DIR = join(import.meta.dirname, "..", "nav");

function componentFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => join(dir, f));
}

const files = [...componentFiles(KIT_DIR), ...componentFiles(NAV_DIR)];

describe("use client boundary", () => {
  it("finds component files to check", () => {
    // Guards the guard: a bad glob would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s declares 'use client' if it imports @tesserix/web", (file) => {
    const source = readFileSync(file, "utf8");
    if (!source.includes('from "@tesserix/web"')) return;

    // Match a real directive statement, not the words appearing in a comment.
    // The first version of this test checked `slice(0, indexOf("import "))`
    // for the substring, and passed with the directive deleted — because the
    // comment above it explains what "use client" is for. A guard that cannot
    // fail is worse than none, so this walks the leading lines and requires
    // the first non-comment, non-blank one to BE the directive.
    const directive = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"))[0];

    expect(directive).toMatch(/^["']use client["'];?$/);
  });
});
