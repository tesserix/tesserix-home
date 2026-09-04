import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isPending, navItems, RAIL_IDS, railNav, ROUTE_IDS } from "@tesserix/console-core";
import { describe, expect, it } from "vitest";

/**
 * Guard: a comment asserting a countable or structural fact can pin it here.
 *
 * `claim({ file, says, check })` registers one. Each registration becomes two
 * rows: an ANCHOR row (`says` still present) and a FACT row (`check`). Separate
 * rows, so a failure says which of the two went wrong.
 *
 * Opt-in — nothing scans for unpinned claims.
 *
 * # What the anchor guarantees
 *
 * `says` must appear, in order, inside a WHOLE-LINE comment in `file` — see
 * `commentText` — with markers and line wrapping flattened by `flatten`.
 *
 * Measured 2026-09-04, each by running the edit and reading the result:
 *
 *   REDS   reword the sentence, delete it, or move the words to a bare string
 *          literal or an identifier.
 *   REDS   move the words to a trailing comment after code (`x = 1; // ...`).
 *   GREEN  re-wrap the paragraph across different lines.
 *   GREEN  prefix "It was never true that" to the anchored sentence. Text
 *          AROUND the anchor is not checked, and substring matching cannot
 *          check it. `check` is what defends the fact; the anchor only keeps
 *          the words there to read.
 *   GREEN  a template literal whose lines begin with `//`. `commentText` reads
 *          lines, not tokens, so that satisfies the anchor.
 *
 * # Rules for a registration
 *
 * - Anchor on comment text, never a line number.
 * - Do not `import()` the module under inspection — read it as text. A `check`
 *   may import `@tesserix/console-core`, a pure data package with no side
 *   effects, when the fact is about that data (the `search.ts` seed).
 * - Run the mutation before writing the sentence that describes it.
 *
 * Paths are workspace-relative, so a claim may name any file in the monorepo.
 * The file sits under `apps/console/lib/` because it needs that vitest
 * project's `@tesserix/console-core` alias, which resolves to source.
 */

/** The monorepo root: `apps/console/lib` -> `apps/console` -> `apps` -> root. */
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Source by workspace-relative path, read once. */
const SOURCE = new Map<string, string>();

function read(file: string): string {
  const cached = SOURCE.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(path.join(WORKSPACE_ROOT, file), "utf-8");
  SOURCE.set(file, source);
  return source;
}

/**
 * Only the whole-line comments of `file`: a line whose trimmed form opens with
 * `//` or `/*`, or that sits inside a block comment.
 *
 * Whole-line only. Recognising a trailing `//` after code means knowing it is
 * not inside a string or a regex, which needs a tokenizer this does not have.
 */
function commentText(file: string): string {
  const collected: string[] = [];
  let inBlock = false;
  for (const line of read(file).split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      collected.push(line.replace(/\*\/.*$/, ""));
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) {
      collected.push(line);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      collected.push(line.replace(/^\s*\/\*+/, "").replace(/\*\/.*$/, ""));
      if (!trimmed.includes("*/")) inBlock = true;
    }
  }
  return collected.join("\n");
}

/** Comment markers and line breaks flattened to single spaces, both sides. */
function flatten(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*|\/\/)\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** How many times `needle` appears in `file`. Plain substring, not a regex. */
function occurrencesOf(needle: string, file: string): number {
  return read(file).split(needle).length - 1;
}

/**
 * The lines of `file` matching `pattern`.
 *
 * `after` restricts the search to below the first line containing that marker.
 * An absent marker yields no lines, so a stale marker reds rather than silently
 * widening back to the whole file.
 */
function linesMatching(pattern: RegExp, file: string, after?: string): string[] {
  const lines = read(file).split("\n");
  const from = after === undefined ? 0 : lines.findIndex((line) => line.includes(after)) + 1;
  return (from === 0 && after !== undefined ? [] : lines.slice(from)).filter((line) =>
    pattern.test(line),
  );
}

/**
 * The bodies of every `name(...)` call starting at column 0, in file order —
 * the file-scope hooks, as opposed to those nested in a `describe`. Column 0 is
 * the distinction because prettier indents everything inside one; each body
 * runs to the next column-0 `});`.
 */
function topLevelBlocks(name: string, file: string): string[] {
  const lines = read(file).split("\n");
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of lines) {
    if (open === null) {
      if (line.startsWith(`${name}(`)) open = [];
      continue;
    }
    if (line.startsWith("});")) {
      blocks.push(open.join("\n"));
      open = null;
      continue;
    }
    open.push(line);
  }
  return blocks;
}

/** Every `.ts`/`.tsx` under `dir`, as workspace-relative paths. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(WORKSPACE_ROOT, dir), { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (child.endsWith(".ts") || child.endsWith(".tsx")) out.push(child);
  }
  return out;
}

/**
 * Every file under `dir` importing `module`, matched as the tail of a `from`
 * specifier so `@/`-aliased and relative spellings both count and a comment
 * naming the module does not. Type-only imports count.
 */
function importersOf(module: string, dir: string): string[] {
  const specifier = new RegExp(
    `from\\s+["'][^"']*${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  );
  return walk(dir)
    .filter((file) => specifier.test(read(file)))
    .sort();
}

interface Claim {
  /** Workspace-relative path of the file carrying the comment. */
  readonly file: string;
  /** A substring of that comment that must still appear in `file`. */
  readonly says: string;
  /** The fact the sentence asserts, as something machine-checkable. */
  readonly check: () => boolean;
}

const CLAIMS: Claim[] = [];

const claim = (registration: Claim): void => {
  CLAIMS.push(registration);
};

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

claim({
  file: "apps/console/components/kit/entity-page.ts",
  says: "Kora's three pages were its only callers",
  // The `page.tsx` importers under `kora/`: foods, users, ai-metrics. The four
  // other Kora importers are the client views beside them, which the sentence
  // does not count.
  check: () =>
    importersOf(
      "components/kit/entity-page",
      "apps/console/app/(console)/kora",
    ).filter((file) => file.endsWith("/page.tsx")).length === 3,
});

claim({
  file: "apps/console/components/kit/entity-page.ts",
  says: "the generic entity index became a fourth",
  // The sentence names ONE importer — `[product]/[entity]/page.tsx`, the
  // caller whose arrival moved this module out from under `kora/`. Asserted as
  // that file's presence rather than as a count of four: the count was the
  // check until the CRM organisations list became a fifth, at which point it
  // reddened a sentence about history that was still true. The claim below
  // counts.
  check: () =>
    importersOf("components/kit/entity-page", "apps/console/app/(console)").includes(
      "apps/console/app/(console)/[product]/[entity]/page.tsx",
    ),
});

claim({
  file: "apps/console/components/kit/entity-page.ts",
  says: "the four §3.4 index surfaces that were this function's only callers",
  // Four §3.4 surfaces (Kora's three plus `[product]/[entity]`) plus the CRM
  // organisations list, which is the caller the sentence says is NOT one of
  // them — five `page.tsx` importers in all. A sixth would have to say which
  // side of that sentence it falls on.
  check: () =>
    importersOf("components/kit/entity-page", "apps/console/app/(console)").filter(
      (file) => file.endsWith("/page.tsx"),
    ).length === 5,
});

claim({
  file: "apps/console/app/(console)/[product]/[entity]/entity-index.tsx",
  says: "The three `import type`s below",
  // `import type` STATEMENTS below the sentence — not the inline `type X`
  // specifiers in the value imports above it, of which `filter-bar` has two.
  //
  // Scoped because the sentence says "below", and both discriminating cases
  // were measured 2026-09-04. Counting file-wide instead: ADD an `import type`
  // above the comment and file-wide is 4 (reds) while the three below are
  // untouched (scoped green) — a false alarm. MOVE one of the three above the
  // comment and file-wide is still 3 (green) while the sentence's three are two
  // (scoped reds) — a miss.
  check: () =>
    linesMatching(
      /^import type /,
      "apps/console/app/(console)/[product]/[entity]/entity-index.tsx",
      "The three `import type`s below",
    ).length === 3,
});

claim({
  file: "apps/console/lib/platform-api.test.ts",
  says: "all 41 call sites are inside `it()` bodies",
  // The count only; where the calls sit is not checkable here. The trailing
  // paren excludes the file's two non-call mentions — the generic declaration
  // and the error string — so no subtraction is needed.
  check: () =>
    occurrencesOf("installFetchStub(", "apps/console/lib/platform-api.test.ts") === 41,
});

claim({
  file: "apps/console/lib/platform-api.test.ts",
  says: "This file has TWO file-scope `afterEach` hooks, and only the second one",
  // Both halves: a count alone stays green if `resetModules` moves to the FIRST
  // hook, which is the misreading the corrected wording exists to prevent.
  check: () => {
    const hooks = topLevelBlocks(
      "afterEach",
      "apps/console/lib/platform-api.test.ts",
    );
    return (
      hooks.length === 2 &&
      !hooks[0].includes("vi.resetModules()") &&
      hooks[1].includes("vi.resetModules()")
    );
  },
});

claim({
  file: "packages/console-core/src/routes.ts",
  says: "NOT because of a cycle. There is none, and none is one edit away:",
  // True only while `nav.ts`'s single reference back is erased at build. A
  // multi-line value import fails too — its `} from "./routes";` line does not
  // start with `import type`. Exactly one, so deleting the import (which the
  // sentence names) reds rather than passing vacuously. `import()` is rejected
  // separately: no `from` clause would show it.
  check: () => {
    const NAV = "packages/console-core/src/nav.ts";
    const imports = linesMatching(/from\s+"\.\/routes"/, NAV);
    const runtime = linesMatching(/(?:require|import)\(\s*["']\.\/routes["']\s*\)/, NAV);
    return imports.length === 1 && /^import type /.test(imports[0]) && runtime.length === 0;
  },
});

claim({
  file: "apps/console/lib/search.ts",
  says: "Uptime, Observability, Databases and Custom domains are exactly those four",
  // A join of the route table's `pending` flag against every rail's items, which
  // no grep expresses honestly. Recomputed the way `search.ts` derives
  // `RAILED_ROUTES` — not by importing `search.ts`, which would test the check
  // against the code it checks. Sorted: the sentence asserts which four, not an
  // order.
  check: () => {
    const railed = new Set(
      RAIL_IDS.flatMap((id) => navItems(railNav(id))).map((item) => item.route),
    );
    const unadvertised = ROUTE_IDS.filter((id) => isPending(id) && !railed.has(id));
    return (
      JSON.stringify([...unadvertised].sort()) ===
      JSON.stringify(
        [
          "platform.uptime",
          "platform.observability",
          "platform.databases",
          "platform.customDomains",
        ].sort(),
      )
    );
  },
});

// ---------------------------------------------------------------------------

describe("the claim registry", () => {
  // Measured 2026-09-04 by emptying CLAIMS and skipping this row: vitest reds
  // with `No test found in suite` for both describes below, AND `can reach
  // packages/` fails. So the empty case is not silent, and this row is not what
  // catches it — it is here to name the cause in one line.
  it("is not empty", () => {
    expect(CLAIMS.length).toBeGreaterThan(0);
  });

  // Measured by renaming a registered file: this row reds naming the path, and
  // the anchor row throws ENOENT. Kept for the message, not for coverage.
  it.each(CLAIMS.map((c) => c.file))("%s exists", (file) => {
    expect(
      existsSync(path.join(WORKSPACE_ROOT, file)),
      `${file} is registered but is not on disk`,
    ).toBe(true);
  });

  // Rooted at `apps/console`, a `packages/` claim cannot be written at all and
  // no row fails. This row is what makes that loud.
  it("can reach packages/, not just apps/", () => {
    expect(CLAIMS.some((c) => c.file.startsWith("packages/"))).toBe(true);
    expect(CLAIMS.some((c) => c.file.startsWith("apps/"))).toBe(true);
  });
});

describe("the comment is still there", () => {
  it.each(CLAIMS.map((c) => [`${c.file} says "${c.says}"`, c] as const))(
    "%s",
    (_name, registration) => {
      expect(
        flatten(commentText(registration.file)).includes(flatten(registration.says)),
        `no comment in ${registration.file} contains "${registration.says}" any ` +
          `more. It was reworded, deleted, or moved out of a comment — update ` +
          `this registration or remove it. The anchor must sit in a WHOLE-LINE ` +
          `comment, not a trailing one.`,
      ).toBe(true);
    },
  );
});

describe("the fact it asserts is still true", () => {
  it.each(CLAIMS.map((c) => [`${c.file} — "${c.says}"`, c] as const))(
    "%s",
    (_name, registration) => {
      expect(
        registration.check(),
        `${registration.file} still says "${registration.says}", but that is no ` +
          `longer true. Fix the sentence — the code is what it is.`,
      ).toBe(true);
    },
  );
});
