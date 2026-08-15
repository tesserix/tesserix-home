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
    const seen = INTERNAL_TOOLS.map((t) => t.subdomain);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("grouping", () => {
  it("assigns every tool to a declared group", () => {
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
