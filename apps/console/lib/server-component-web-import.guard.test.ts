import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: a SERVER module must never import from `@tesserix/web`.
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
 * # Why the walk covers lib/ and components/ and .ts, not just app/**.tsx (#545)
 *
 * The first version walked `app/` for `.tsx` only, which left the modules those
 * pages import unguarded. `lib/` is where the console's server-side data
 * modules live; a `lib/*.ts` that pulls in a `"use client"` module reintroduces
 * the same undefined-export failure one hop upstream, in a file the guard never
 * opened. Widening to all three roots and to `.ts` was checked against the tree
 * as it stood: it surfaced no existing violation, so nothing here is excused.
 *
 * # How this divides with `components/kit/use-client-boundary.test.ts`
 *
 * That test states the same invariant from the other side — a module importing
 * `@tesserix/web` MUST declare `"use client"` — and is strictly stricter about
 * the directive: it requires the first non-comment, non-blank line to BE the
 * directive, which is what Next actually honours, whereas the regex below
 * accepts the directive on any line of its own. But it reads only
 * `components/kit/*.tsx` and `components/nav/*.tsx`, one level deep, and it is
 * that strictness on those two directories that it contributes. This walk is
 * the breadth: `app/`, `lib/` and `components/` recursively, `.ts` as well as
 * `.tsx`. They overlap on those two directories by design — dropping either
 * loses something the other does not have.
 *
 * # The fix when this fails
 *
 * Do not add `"use client"` to the page — a page is where the server work
 * lives. Extract the markup that needs the component into its own `"use
 * client"` module beside it and import that, which is what `page-header.tsx`
 * does and what the profile page does now.
 */

const CONSOLE_ROOT = path.resolve(__dirname, "..");

/**
 * Every directory of console source that can end up on the server. `app/` for
 * the routes themselves, `lib/` for the modules they call, `components/` for
 * the markup they compose — a server component's whole import graph inside the
 * app lives in these three.
 */
const SOURCE_ROOTS: readonly string[] = ["app", "lib", "components"];

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
    else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.includes(".test.")
    )
      out.push(full);
  }
  return out;
}

const serverModulesUnder = (root: string) =>
  walk(path.join(CONSOLE_ROOT, root)).filter(
    (file) => !USE_CLIENT.test(readFileSync(file, "utf-8")),
  );

const SERVER_MODULES = SOURCE_ROOTS.flatMap(serverModulesUnder);

describe("server modules do not import @tesserix/web", () => {
  it("walks app/, lib/ and components/", () => {
    // Narrowing the walk is how this guard goes quiet without any assertion
    // failing — every row below is generated FROM these roots, so a dropped
    // root deletes its own coverage rather than failing it. #545 was exactly
    // that: `app/**.tsx` only, with `lib/` unguarded. Widening is welcome;
    // narrowing has to be a deliberate edit here.
    expect(SOURCE_ROOTS).toEqual(["app", "lib", "components"]);
  });

  // Vacuity, per root: a walk that found nothing would pass and read as
  // coverage.
  it.each(SOURCE_ROOTS)("finds server modules to check under %s/", (root) => {
    expect(serverModulesUnder(root).length).toBeGreaterThan(0);
  });

  it.each(SERVER_MODULES.map((f) => path.relative(CONSOLE_ROOT, f)))(
    "%s",
    (file) => {
      const source = readFileSync(path.join(CONSOLE_ROOT, file), "utf-8");
      expect(
        /from\s+["']@tesserix\/web["']/.test(source),
        `${file} is a server module and imports @tesserix/web, whose barrel is ` +
          `"use client" — its exports will be undefined at render. Move the markup ` +
          `into a "use client" module beside it, as page-header.tsx does.`,
      ).toBe(false);
    },
  );
});
