import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_IDS, productEntities, routeForPath } from "@tesserix/console-core";

/**
 * Guard: every console page is reachable by the access gate, and every server
 * action reaches a capability check (#264, RBAC R4).
 *
 * # Why this is a DERIVED enumeration, and why that is the whole point
 *
 * `lib/auth/render-path-capabilities.test.ts` already asserts that the files
 * it lists call the live gate. It is a good check and this does not replace
 * it — but its own comment names its limit:
 *
 *   > Keep this list exhaustive — it is not derived from anything
 *
 * A hand-maintained list cannot catch the regression that matters. A NEW
 * server action that gates nothing is not a list entry that went wrong; it is
 * a list entry nobody added, and the suite stays green. Same for a new page:
 * one with no route entry is invisible to #262's gate, which resolves a
 * request path through the route table.
 *
 * So these walk the filesystem. A file that exists is a file that is checked,
 * and the only way out is an exception named below with a reason.
 *
 * # What "reaches a check" means, and why one hop
 *
 * Several actions are thin shells over a seam that owns the gate —
 * `tools/actions.ts` delegates to `lib/tools-write.ts`, `tenants/actions.ts`
 * to `lib/tenant-lifecycle-write.ts`, the CRM actions to `withCrmWrite`. A
 * same-file check would call all of those ungated, which is false and would
 * train everyone to add the file to an ignore list.
 *
 * So the check follows local imports ONE hop. That is deliberate rather than
 * lazy: an unbounded walk would eventually reach a gate through some shared
 * utility and pass everything, which is the failure mode of every "is it
 * reachable" check written too cleverly. One hop matches how these modules are
 * actually written — shell, then seam — and anything deeper should be
 * restructured rather than accommodated.
 */

const CONSOLE_ROOT = path.resolve(__dirname, "..");
const PAGES_ROOT = path.join(CONSOLE_ROOT, "app/(console)");

/** The gate helpers that constitute a capability check. */
const GATE = /checkOperatorCapabilityLive|assertCapability|withCrmWrite/;

/**
 * Server-action modules that legitimately gate nothing.
 *
 * Each needs a REASON, not just an entry — an exception list without reasons
 * becomes the ignore list this guard exists to replace.
 */
const UNGATED_BY_DESIGN: Readonly<Record<string, string>> = {
  // Pre-authentication by definition: these are how an operator signs in, so
  // requiring a capability would make signing in depend on already having one.
  "app/login/actions.ts":
    "the login form itself — runs before any session exists",
  // Documented at length in the file: a read that asks whether a path is free,
  // ahead of a write that secrets-api gates on the operator's own token. A
  // console-side check would duplicate that gate rather than add one.
  "app/(console)/platform/secrets/new/actions.ts":
    "a read; secrets-api gates the write it precedes on the operator's own token",
  // The other deliberate exception render-path-capabilities.test.ts asserts:
  // secrets-api refuses the write on the operator's own token regardless.
  "app/(console)/platform/secrets/[...path]/actions.ts":
    "secrets-api refuses the write on the operator's own token",
};

function walk(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(entry)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(CONSOLE_ROOT, file);

/** `app/(console)/platform/crm/page.tsx` -> `/platform/crm`. Route groups —
 *  `(console)`, `(marketing)` — contribute no path segment, which is what
 *  makes the root page resolve to `/` rather than to `/page`. */
function urlForPage(file: string): string {
  const fromRoot = path.relative(PAGES_ROOT, file).replace(/page\.tsx$/, "");
  const segments = fromRoot
    .split(path.sep)
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segments.join("/");
}

/**
 * The request paths a page file actually answers.
 *
 * One each, except for the two generic product pages.
 * `app/(console)/[product]/` and `app/(console)/[product]/[entity]/` have no
 * literal path of their own — `routeForPath("/[product]")` matches nothing,
 * because `[product]` is a filesystem notation and the route table holds
 * request paths. Their real paths are enumerable, because the param checks
 * enumerate them: `resolveProductParam` refuses every segment outside
 * `PRODUCT_IDS`, and `resolveEntitySurface` refuses every second segment
 * outside `productEntities(product)`. So the expansion below is exactly the
 * set these two pages can render, product by product.
 *
 * Expanding rather than excepting is what keeps the guard's promise for them:
 * a product — or an entity type — added to `PRODUCTS` without its route ids
 * fails this walk, instead of the page quietly rendering on the entry
 * capability.
 *
 * Other dynamic segments need no expansion — `/platform/tickets/[id]` resolves
 * through `routeForPath`'s prefix match to `platform.tickets`, which is the
 * behaviour that file's own comment calls load-bearing for record pages.
 */
function urlsForPage(file: string): string[] {
  const url = urlForPage(file);
  if (!url.includes("[product]")) return [url];
  return PRODUCT_IDS.flatMap((id) => {
    const forProduct = url.replace("[product]", id);
    if (!forProduct.includes("[entity]")) return [forProduct];
    return productEntities(id).map((type) => forProduct.replace("[entity]", type));
  });
}

const PAGES = walk(PAGES_ROOT, (f) => f === "page.tsx").sort();

describe("every console page is reachable by the access gate", () => {
  // Vacuity. An empty `it.each` passes and reads as coverage — the failure
  // mode #264 calls out, having already bitten twice in this milestone's
  // sibling work (#238, #242). A console with no pages is a broken walk, not
  // a clean bill of health.
  it("finds pages to check at all", () => {
    expect(PAGES.length).toBeGreaterThan(20);
  });

  it.each(PAGES.flatMap((f) => urlsForPage(f).map((url) => [rel(f), url])))(
    "%s (%s) resolves to a route entry",
    (_file, url) => {
      // #262 resolves a REQUEST PATH through the route table to find the
      // capability that guards it. A page no route resolves to falls back to
      // the console entry capability — so it would be served to anyone who can
      // log in, silently, however sensitive it is.
      expect(
        routeForPath(url),
        `no route in console-core resolves ${url} — the access gate cannot guard it`,
      ).toBeDefined();
    },
  );
});

const ACTION_MODULES = walk(
  path.join(CONSOLE_ROOT, "app"),
  (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
)
  .filter((f) => !f.includes(".test."))
  .filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf-8")))
  .filter((f) => /export\s+async\s+function\s+\w+/.test(readFileSync(f, "utf-8")))
  .sort();

/** The module's own text, plus the text of every local module it imports —
 *  one hop. See the header for why the depth is fixed. */
function textWithSeams(file: string): string {
  const own = readFileSync(file, "utf-8");
  const imports = [...own.matchAll(/from\s+["']@\/([^"']+)["']/g)].map((m) => m[1]);
  const seams = imports.map((spec) => {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const candidate = path.join(CONSOLE_ROOT, spec + ext);
      try {
        return readFileSync(candidate, "utf-8");
      } catch {
        // Not this extension; try the next.
      }
    }
    return "";
  });
  return [own, ...seams].join("\n");
}

describe("every server action reaches a capability check", () => {
  it("finds server actions to check at all", () => {
    expect(ACTION_MODULES.length).toBeGreaterThan(5);
  });

  it.each(ACTION_MODULES.map((f) => rel(f)))("%s gates its writes", (file) => {
    const reason = UNGATED_BY_DESIGN[file];
    if (reason) {
      // An exception must still be a real file. A stale entry would silently
      // excuse nothing while looking like it excuses something.
      expect(reason.length, `${file} is excepted with no reason`).toBeGreaterThan(20);
      return;
    }
    expect(
      GATE.test(textWithSeams(path.join(CONSOLE_ROOT, file))),
      `${file} exports a server action but neither it nor the modules it imports ` +
        `calls a capability check. Add one, or add the file to UNGATED_BY_DESIGN with a reason.`,
    ).toBe(true);
  });

  // An exception for a file that no longer exists is worse than none: it reads
  // as a considered decision while covering nothing.
  it.each(Object.keys(UNGATED_BY_DESIGN))("%s, excepted, still exists", (file) => {
    expect(() => statSync(path.join(CONSOLE_ROOT, file))).not.toThrow();
  });
});
