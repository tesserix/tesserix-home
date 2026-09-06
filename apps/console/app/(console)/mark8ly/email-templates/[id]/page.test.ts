import { describe, expect, it, vi } from "vitest";

import { decodeSegment } from "./page";

/**
 * The route id is `<source>:<key>`, and a colon is percent-encoded in a URL.
 *
 * These pin a bug that reached production: the page took `params.id` raw on the
 * belief that Next had already decoded it. It has not — `params` yields the
 * literal `mark8ly%3Agiftcard_delivery`. `fetchEmailTemplate` then encoded it
 * again, platform-api decoded once, found no colon, and refused it as a bare
 * key. Every detail page failed while the list worked, because only this route
 * carries an encoded id.
 *
 * A test that hands the page an already-decoded id cannot catch that, which is
 * why the original suite passed.
 */
describe("decodeSegment", () => {
  it("decodes the encoded colon a real route segment carries", () => {
    // THE ROW THIS FUNCTION EXISTS FOR — the exact shape the browser sends.
    expect(decodeSegment("mark8ly%3Agiftcard_delivery")).toBe("mark8ly:giftcard_delivery");
  });

  it("leaves an already-decoded id alone, so a hand-typed URL still works", () => {
    expect(decodeSegment("mark8ly:orderdoc_invoice")).toBe("mark8ly:orderdoc_invoice");
  });

  it("passes a malformed sequence through instead of throwing", () => {
    // `decodeURIComponent` throws on a lone `%`. In a server component that is
    // a 500, where the honest answer is the API refusing an id that cannot
    // exist. Passing it through lets the request be judged on its merits.
    expect(() => decodeSegment("mark8ly%3Anot%valid")).not.toThrow();
    expect(decodeSegment("mark8ly%3Anot%valid")).toBe("mark8ly%3Anot%valid");
  });

  it("does not decode twice, so a key containing an escaped percent survives", () => {
    // Single decode only: %253A is a literal "%3A" in the key, not a colon.
    expect(decodeSegment("mark8ly%253Akey")).toBe("mark8ly%3Akey");
  });
});

/**
 * The helper being correct is not the bug that shipped. The bug was the PAGE
 * not using it — `decodeSegment` above would have passed against the broken
 * code, because the broken code simply never called anything like it.
 *
 * So this drives the page itself and asserts what reaches the API client.
 */
describe("the page decodes before it fetches", () => {
  it("hands fetchEmailTemplate a decoded id, not the raw route segment", async () => {
    vi.resetModules();
    const fetchEmailTemplate = vi.fn().mockRejectedValue(new Error("stop after the call"));
    vi.doMock("@/lib/platform-api", () => ({
      fetchEmailTemplate,
      PlatformApiError: class extends Error {
        status = 500;
      },
    }));
    vi.doMock("@tesserix/platform-auth", () => ({
      getCurrentSession: async () => null,
      hasCapability: () => false,
    }));

    const { default: EmailTemplatePage } = await import("./page");
    await EmailTemplatePage({
      params: Promise.resolve({ id: "mark8ly%3Agiftcard_delivery" }),
    });

    // Not `mark8ly%3Agiftcard_delivery`. That value, re-encoded by the client
    // into `mark8ly%253A...`, is what platform-api refused as a bare key.
    expect(fetchEmailTemplate).toHaveBeenCalledWith("mark8ly:giftcard_delivery");
    vi.doUnmock("@/lib/platform-api");
    vi.doUnmock("@tesserix/platform-auth");
  });
});
