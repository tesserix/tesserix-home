import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

async function cspDirectives(): Promise<Record<string, string>> {
  const headerGroups = await nextConfig.headers!();
  const csp = headerGroups
    .flatMap((group) => group.headers)
    .find((header) => header.key === "Content-Security-Policy");

  return Object.fromEntries(
    csp!.value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

describe("content security policy", () => {
  it("allows the self-hosted OpenPanel tracking script to load", async () => {
    expect((await cspDirectives())["script-src"]).toContain(
      "https://analytics.tesserix.app",
    );
  });

  it("allows events to be posted to the OpenPanel API", async () => {
    expect((await cspDirectives())["connect-src"]).toContain(
      "https://*.tesserix.app",
    );
  });
});
