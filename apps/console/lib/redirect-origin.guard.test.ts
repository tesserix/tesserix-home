import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: never build a browser-facing URL from `request.nextUrl.origin`.
 *
 * Behind the ingress that is the pod's own bind address, so the browser is sent
 * to `http://0.0.0.0:3000`, which it cannot reach. This codebase has shipped
 * that bug THREE times — in apps/web's auth callback, in the console's
 * middleware, and in the console's OIDC callback — each time in a redirect that
 * worked perfectly in local dev, where nextUrl.origin happens to be correct.
 *
 * `lib/public-origin.ts` exists for this. The rule is mechanical and the
 * failure is invisible until production, which is exactly the shape a test
 * should enforce rather than a comment.
 */

const APP_ROOT = join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo"]);

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

/** The one legitimate use: the helper's own fallback for local dev. */
const ALLOWED = ["lib/public-origin.ts"];

/**
 * Strip comments before matching.
 *
 * Without this the guard trips on prose — including the comment in the auth
 * callback explaining why NOT to use `nextUrl.origin`. The `"use client"` guard
 * in this repo shipped with exactly that defect in reverse: it matched the
 * directive inside a comment and passed while the real directive was absent.
 * A check that reads comments is checking the wrong thing in both directions.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("browser-facing URLs never come from nextUrl.origin", () => {
  it("finds no unguarded uses outside the helper", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(APP_ROOT)) {
      const rel = file.slice(APP_ROOT.length + 1);
      if (ALLOWED.some((a) => rel === a)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      // `nextUrl.searchParams` and friends are fine — only `.origin` builds a URL.
      if (/nextUrl\.origin/.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      `Use publicOrigin(request) from lib/public-origin.ts instead. ` +
        `nextUrl.origin is the pod's bind address behind the ingress, so the ` +
        `browser gets redirected to 0.0.0.0. Offending files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("scans a meaningful number of files", () => {
    // Guards the guard: if the walk silently stopped matching (a renamed
    // directory, a changed extension), the check above would pass by finding
    // nothing to look at.
    expect(sourceFiles(APP_ROOT).length).toBeGreaterThan(20);
  });
});
