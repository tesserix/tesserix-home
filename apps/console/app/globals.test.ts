import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { colors, colorsDark } from "@tesserix/console-core";

// Guards against the drift the brief explicitly calls out: globals.css's
// :root block hand-copies console-core's tokens.ts values (CSS has no way to
// import them directly, and console-core must stay renderer-free). This test
// is the enforcement mechanism — it parses globals.css's :root custom
// properties and asserts every one that corresponds to a console-core color
// token still matches tokens.ts, so a future tokens.ts edit that isn't
// mirrored here fails CI instead of silently drifting.

const CSS_PATH = new URL("./globals.css", import.meta.url);

function extractRootVars(css: string): Record<string, string> {
  const match = css.match(/:root\s*{([\s\S]*?)\n}/);
  if (!match) {
    throw new Error("globals.css: no :root block found");
  }
  const vars: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const decl = line.match(/^\s*--([\w-]+):\s*(.+?);\s*$/);
    if (decl) {
      vars[decl[1]] = decl[2];
    }
  }
  return vars;
}

// tokens.ts keys are camelCase (e.g. "sidebarPrimary", "chart1"); globals.css
// custom properties are kebab-case (e.g. "--sidebar-primary", "--chart-1").
function toCssVarName(tokenKey: string): string {
  return tokenKey.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();
}

describe("globals.css :root tokens match @tesserix/console-core", () => {
  const cssVars = extractRootVars(readFileSync(CSS_PATH, "utf8"));

  it.each(Object.entries(colors))(
    "--%s matches console-core's tokens.colors.%s",
    (tokenKey, tokenValue) => {
      const cssVarName = toCssVarName(tokenKey);
      const cssValue = cssVars[cssVarName];
      expect(
        cssValue,
        `globals.css is missing --${cssVarName} (expected from console-core tokens.colors.${tokenKey} = "${tokenValue}")`,
      ).toBeDefined();
      expect(
        cssValue,
        `globals.css --${cssVarName} = "${cssValue}" does not match console-core tokens.colors.${tokenKey} = "${tokenValue}" — update globals.css to match tokens.ts (the source of truth).`,
      ).toBe(tokenValue);
    },
  );
});

// The dark palette drifts just as easily as the light one, and more quietly:
// nobody notices a wrong dark value until they switch themes. This block is
// the explicit `[data-theme="dark"]` selector rather than the media query —
// the two carry identical declarations, and the assertion below proves it, so
// checking one is enough to catch a value going stale in tokens.ts.
function extractBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*{([\\s\\S]*?)\\n}`));
  if (!match) {
    throw new Error(`globals.css: no "${selector}" block found`);
  }
  const vars: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const decl = line.match(/^\s*--([\w-]+):\s*(.+?);\s*$/);
    if (decl) {
      vars[decl[1]] = decl[2];
    }
  }
  return vars;
}

describe("globals.css dark tokens match @tesserix/console-core", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const darkVars = extractBlock(css, ':root[data-theme="dark"]');

  it.each(Object.entries(colorsDark))(
    "--%s matches console-core's tokens.colorsDark.%s",
    (tokenKey, tokenValue) => {
      const cssVarName = toCssVarName(tokenKey);
      expect(
        darkVars[cssVarName],
        `globals.css [data-theme="dark"] is missing --${cssVarName} (expected colorsDark.${tokenKey} = "${tokenValue}")`,
      ).toBeDefined();
      expect(
        darkVars[cssVarName],
        `globals.css [data-theme="dark"] --${cssVarName} does not match colorsDark.${tokenKey}`,
      ).toBe(tokenValue);
    },
  );

  it("declares the same values under prefers-color-scheme as under data-theme", () => {
    // A viewer on the default "system" setting gets NO data-theme attribute,
    // so the media query is the only thing serving them. If the two blocks
    // diverge, most users see a palette nobody reviewed.
    const mediaVars = extractBlock(css, ':root:not([data-theme="light"])');
    expect(mediaVars).toEqual(darkVars);
  });
});
