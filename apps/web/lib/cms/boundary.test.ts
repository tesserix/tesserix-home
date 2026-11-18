import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The CMS readers (lib/cms/client.ts, the getters) are server-only: they read env, log, and
// would otherwise ship in the browser bundle. Client components get data as props.

const root = path.join(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
const files = ["app", "components"].flatMap((d) => walk(path.join(root, d)));
const READERS = /from "@\/lib\/cms\/(client|products|site)"/;
const isClient = (src: string) => /^\s*"use client";/m.test(src);

describe("client/server boundary for CMS reads", () => {
  it("no \"use client\" file imports the CMS client or getters (types and helpers only)", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return isClient(src) && READERS.test(src.replace(/import type [^;]+;/g, ""));
    });
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it("the root layout does not read the CMS, so /admin and /auth never wait on it", () => {
    const src = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
    expect(READERS.test(src)).toBe(false);
  });
});
