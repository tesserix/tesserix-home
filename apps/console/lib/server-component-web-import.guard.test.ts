import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: a SERVER component must never import from `@tesserix/web`.
 *
 * `@tesserix/web`'s barrel carries its own `"use client"`. Imported into a
 * server component, its exports resolve to `undefined`, and React fails at
 * render with:
 *
 *     Element type is invalid: expected a string (for built-in components) or
 *     a class/function (for composite components) but got: undefined.
 *
 * # Why a test and not a comment
 *
 * There was already a comment. `components/kit/page-header.tsx` carries the
 * whole explanation at its own `"use client"` directive, including the words
 * "which neither typecheck nor build catches" — and the profile page
 * (`/platform/profile`) shipped to production importing `Badge` into a server
 * component anyway, and broke on first load.
 *
 * That is the failure mode this repo has already learned once, in
 * `server-action-type-export.guard.test.ts`: `tsc --noEmit` is happy because
 * the TypeScript is valid, `next build` is happy because it compiles and emits
 * the chunk, eslint has no rule, and unit tests pass because they render the
 * component directly rather than through the server boundary. It surfaces only
 * when a request actually renders the page. A green CI run means nothing here,
 * so the enforcement has to be a walk of the source.
 *
 * # The fix when this fails
 *
 * Do not add `"use client"` to the page — a page is where the server work
 * lives. Extract the markup that needs the component into its own `"use
 * client"` module beside it and import that, which is what `page-header.tsx`
 * does and what the profile page does now.
 */

const CONSOLE_ROOT = path.resolve(__dirname, "..");
const APP_ROOT = path.join(CONSOLE_ROOT, "app");

/**
 * The directive, wherever it sits.
 *
 * Matched on its own line rather than by reading the first N lines: several of
 * these files open with a long comment explaining WHY they are client
 * components, so `"use client"` can be a dozen lines down. A shallower check
 * reports those as server components — which is exactly the false positive
 * that made me look past `publish-outcome.tsx` while diagnosing this.
 */
const USE_CLIENT = /^\s*["']use client["'];?\s*$/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

const SERVER_COMPONENTS = walk(APP_ROOT).filter(
  (file) => !USE_CLIENT.test(readFileSync(file, "utf-8")),
);

describe("server components do not import @tesserix/web", () => {
  // Vacuity: a walk that found nothing would pass and read as coverage.
  it("finds server components to check at all", () => {
    expect(SERVER_COMPONENTS.length).toBeGreaterThan(5);
  });

  it.each(SERVER_COMPONENTS.map((f) => path.relative(CONSOLE_ROOT, f)))(
    "%s",
    (file) => {
      const source = readFileSync(path.join(CONSOLE_ROOT, file), "utf-8");
      expect(
        /from\s+["']@tesserix\/web["']/.test(source),
        `${file} is a server component and imports @tesserix/web, whose barrel is ` +
          `"use client" — its exports will be undefined at render. Move the markup ` +
          `into a "use client" module beside it, as page-header.tsx does.`,
      ).toBe(false);
    },
  );
});
