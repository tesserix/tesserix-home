import { describe, expect, it } from "vitest";

import { swrFetcher } from "./client";

// A bare string key type-checks (SWR's Key is loose) and then destructures
// character-wise: "/tax-rates" becomes path "/" and search "t", producing a
// request to /gw?0=t. The page showed "Could not load" and its calculator never
// rendered, with nothing in the UI pointing at the cause.
describe("swrFetcher", () => {
  it("rejects a bare string key instead of silently requesting the wrong path", () => {
    expect(() => swrFetcher("/tax-rates" as unknown as [string])).toThrow(
      /key must be a tuple/,
    );
  });

  it("names the offending key and the fix in the message", () => {
    expect(() => swrFetcher("/tax-rates" as unknown as [string])).toThrow(
      /useSWR\(\["\/tax-rates"\], swrFetcher\)/,
    );
  });
});
