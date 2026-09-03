import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_TOOLS,
  TOOL_GROUPS,
  toolUrl,
  toolsInGroup,
  type ToolGroup,
} from "./tools";

describe("the tool list is data, not markup", () => {
  it("derives URLs from the environment's base domain", () => {
    const zitadel = INTERNAL_TOOLS.find((t) => t.name === "Zitadel");
    expect(zitadel).toBeDefined();
    expect(toolUrl(zitadel!, "tesserix.app")).toBe("https://auth.tesserix.app");
    // The point of deriving: a non-production console must not link operators
    // at production tools.
    expect(toolUrl(zitadel!, "dev.tesserix.app")).toBe(
      "https://auth.dev.tesserix.app",
    );
  });

  it("hardcodes no absolute URLs", () => {
    // A full URL in the data would defeat the environment awareness above and
    // would not fail visibly — it would just always point at prod.
    for (const tool of INTERNAL_TOOLS) {
      expect(tool.subdomain, `${tool.name} looks like a full URL`).not.toMatch(
        /^https?:|\./,
      );
    }
  });

  it("has no duplicate subdomains", () => {
    // Still asserted, but it is no longer the only guarantee: platform_tools has
    // a UNIQUE constraint on subdomain (migration 0031). This keeps the FALLBACK
    // list honest — it is what renders when the platform API cannot be reached.
    const seen = INTERNAL_TOOLS.map((t) => t.subdomain);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("holds exactly the directory the migrations describe", async () => {
    // The literal and the migrations are two copies of one directory. This is
    // the only thing that keeps them equal (#499).
    //
    // It replaces a one-directional check that read 0031 alone and asked
    // whether each fallback subdomain appeared ANYWHERE in the file. That
    // missed both ways drift actually happens:
    //
    //   - a tool added by migration and not here — the fallback then serves a
    //     directory shorter than the live one during an outage, silently;
    //   - a tool DELETED by migration and left here — 0042 removed
    //     `secret-service`, and a `toContain` against 0031 still passes for it
    //     forever, because 0031 does still mention it. That is exactly the
    //     drift #486 introduced in the other copy and nobody noticed.
    //
    // So the expectation is computed the way the database computes it: every
    // seeded row, minus every deleted one, in migration order.
    const expected = await directoryFromMigrations();

    // Compared as sorted `subdomain → name` lines rather than as Maps: the
    // failure then names the tool that drifted instead of printing two maps.
    const fromMigrations = Array.from(
      expected,
      ([subdomain, name]) => `${subdomain} → ${name}`,
    ).sort();
    const fromFallback = INTERNAL_TOOLS.map(
      (t) => `${t.subdomain} → ${t.name}`,
    ).sort();

    expect(
      fromFallback,
      "the fallback and the migrations describe different directories",
    ).toEqual(fromMigrations);
  });
});

/**
 * The tools directory as the migrations leave it: `subdomain -> name`.
 *
 * Reads every migration rather than a named pair, so a future 0050 that adds
 * or removes a tool is picked up without editing this test — the failure mode
 * this guards against is precisely someone changing the directory and not
 * thinking about the second copy.
 */
async function directoryFromMigrations(): Promise<Map<string, string>> {
  const dir = new URL("../../../apps/web/db/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const directory = new Map<string, string>();
  for (const file of files) {
    const sql = await readFile(new URL(file, dir), "utf8");
    if (!sql.includes("platform_tools")) continue;

    for (const statement of insertsInto(sql, "platform_tools")) {
      // ('Name', 'subdomain', 'purpose', … — name and subdomain are the two
      // leading literals of each VALUES row and neither may contain a quote.
      const rows = Array.from(
        statement.matchAll(/\(\s*'([^']+)',\s*'([^']+)'/g),
      );
      for (const [, name, subdomain] of rows) {
        directory.set(subdomain, name);
      }
    }

    const deletions = Array.from(
      sql.matchAll(
        /DELETE\s+FROM\s+platform_tools\s+WHERE\s+subdomain\s*=\s*'([^']+)'/gi,
      ),
    );
    for (const [, subdomain] of deletions) {
      directory.delete(subdomain);
    }
  }

  // A directory that parsed to nothing would make every assertion above vacuous
  // — the classic way a regex-driven test goes quietly green after a schema
  // rename.
  expect(directory.size, "parsed no tools out of the migrations").toBeGreaterThan(0);
  return directory;
}

/**
 * The body of each `INSERT INTO <table> … VALUES …;` statement in a file.
 *
 * The statement ends at a semicolon that ENDS ITS LINE, not at the first
 * semicolon. 0031 seeds the note "Reached outside the Istio gateway; its own
 * login." — splitting on the first `;` truncates the statement mid-row and
 * silently drops the six tools after it, which is a green test asserting
 * almost nothing.
 */
function insertsInto(sql: string, table: string): string[] {
  const bodies: string[] = [];
  const opening = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(`, "gi");
  for (const match of Array.from(sql.matchAll(opening))) {
    const rest = sql.slice(match.index);
    const end = /;[ \t]*(?:\r?\n|$)/.exec(rest);
    bodies.push(end ? rest.slice(0, end.index) : rest);
  }
  return bodies;
}

describe("grouping", () => {
  it("assigns every tool to a declared group", () => {
    // The live path's guarantee is now a foreign key with ON DELETE RESTRICT.
    // This asserts the same thing about the fallback, which no foreign key
    // covers.
    const declared = new Set<ToolGroup>(TOOL_GROUPS.map((g) => g.key));
    for (const tool of INTERNAL_TOOLS) {
      expect(declared, `${tool.name} has an undeclared group`).toContain(
        tool.group,
      );
    }
  });

  it("leaves no group empty", () => {
    // An empty group renders as a heading with nothing under it, which reads
    // as a loading failure rather than an absence.
    //
    // NOTE: with groups in platform_tool_groups this can no longer be
    // guaranteed for the LIVE directory — a foreign key cannot express "and at
    // least one tool references you". The renderer skips an empty group
    // (components/internal-tools.tsx) and internal-tools.render.test.tsx covers
    // that. What this test still guarantees is the fallback.
    for (const group of TOOL_GROUPS) {
      expect(
        toolsInGroup(group.key).length,
        `group "${group.label}" is declared but empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers every tool exactly once across the groups", () => {
    const total = TOOL_GROUPS.reduce(
      (sum, g) => sum + toolsInGroup(g.key).length,
      0,
    );
    expect(total).toBe(INTERNAL_TOOLS.length);
  });
});

describe("entries say something useful", () => {
  it("gives every tool a purpose a newcomer could act on", () => {
    for (const tool of INTERNAL_TOOLS) {
      expect(tool.purpose.length, `${tool.name} has no purpose`).toBeGreaterThan(
        15,
      );
      // A directory whose descriptions restate the name teaches nothing.
      expect(
        tool.purpose.toLowerCase(),
        `${tool.name}'s purpose just restates its name`,
      ).not.toBe(tool.name.toLowerCase());
    }
  });

  it("records access notes only where there is something real to say", () => {
    // Guards against the field drifting into "unknown" everywhere, which would
    // be noise, or into guesses, which would be worse than silence.
    const noted = INTERNAL_TOOLS.filter((t) => t.note);
    expect(noted.length).toBeGreaterThan(0);
    expect(noted.length).toBeLessThan(INTERNAL_TOOLS.length / 2);
    for (const tool of noted) {
      expect(tool.note!.toLowerCase()).not.toContain("unknown");
    }
  });
});
