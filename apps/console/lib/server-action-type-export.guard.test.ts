import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: a `"use server"` module must never carry an `export type { … };`
 * statement.
 *
 * Next.js compiles a `"use server"` module by enumerating its exports and
 * passing every one of them to `ensureServerEntryExports([...])` as a runtime
 * value. A type-only re-export has no runtime value — TypeScript erased it —
 * so the generated call references an identifier that was never defined and
 * the module throws `ReferenceError: <Name> is not defined` the moment it is
 * evaluated.
 *
 * That is a whole-page failure, not a degraded one: the throw happens at
 * module evaluation, before any handler runs, so every route importing the
 * module renders the server-error screen.
 *
 * WHY A TEST AND NOT A COMMENT. Nothing else in the pipeline catches it.
 * `tsc --noEmit` is happy — the TypeScript is valid. `next build` is happy —
 * it compiles and emits the broken chunk without complaint. `eslint` has no
 * rule for it. It surfaces only when a request actually renders the page, so
 * a green CI run means nothing here. The console shipped exactly this to
 * production in three separate action modules (`crm/suppressions`,
 * `crm/organisations/new`, `crm/[organisation]`), where it broke the CRM
 * organisation detail page.
 *
 * WHAT IS AND IS NOT BANNED. Only the type-only re-export *statement*. Both
 * other ways of exporting a type from these modules were tested against a
 * real `next build` and are correctly erased:
 *
 *   export type Foo = { … };     // SAFE — type alias declaration
 *   export { type Foo };         // SAFE — inline type modifier
 *   export type { Foo };         // BANNED — emitted as a runtime binding
 *
 * So this is not "types may not leave a server module". If one genuinely
 * needs re-exporting, `export { type Foo }` does it safely. In practice the
 * better answer is what the fix did: import the type from where it is
 * defined (`lib/crm-write.ts`) instead of laundering it through an action
 * module that has no reason to own it.
 */

const APP_ROOT = join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * The directive has to be the module's first statement to take effect, so
 * only the opening bytes are worth inspecting — and checking a prefix keeps
 * an unrelated `"use server"` inside a string or a comment further down the
 * file from being read as a directive.
 */
function isServerModule(source: string): boolean {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use server["']/.test(source);
}

/** `export type {` — the banned statement. Whitespace-tolerant, comments stripped. */
const TYPE_REEXPORT = /\bexport\s+type\s*\{/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const serverModules = sourceFiles(APP_ROOT)
  .map((path) => ({ path, source: readFileSync(path, "utf8") }))
  .filter(({ source }) => isServerModule(source));

describe('"use server" modules never re-export a type', () => {
  // If the walk or the directive match ever breaks, `it.each` over an empty
  // list is a silently passing suite — the same failure mode this guard
  // exists to prevent. The console has server-action modules; assert we
  // actually found some.
  it("finds the server-action modules it is meant to be checking", () => {
    expect(serverModules.length).toBeGreaterThan(0);
  });

  it.each(serverModules.map(({ path, source }) => [relative(APP_ROOT, path), source]))(
    "%s",
    (relPath, source) => {
      expect(
        TYPE_REEXPORT.test(stripComments(source)),
        `${relPath} is a "use server" module containing \`export type { … }\`. Next.js emits every export of a server module as a runtime binding, and a type has none — this throws "ReferenceError: … is not defined" at module evaluation and breaks every page importing it. Neither tsc nor next build catches it. Use \`export { type Foo }\`, or import the type from where it is defined instead.`,
      ).toBe(false);
    },
  );
});
