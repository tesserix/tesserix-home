import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api-error";
import { parsePlatformSources, slugsDeclaring } from "./platform-sources";

/** The body platform-api's `sources` module actually returns on this
 *  deployment, from its own package doc. */
const BODY = {
  endpoints: { onboarding: ["mark8ly"], outbox: ["mark8ly"] },
  entities: { tenants: ["mark8ly"], users: ["kora"] },
};

describe("parsePlatformSources", () => {
  it("reads the deployment's declarations as the API sent them", () => {
    expect(parsePlatformSources(BODY)).toEqual(BODY);
  });

  it("accepts an estate that federates nothing", () => {
    // Two empty objects is a legitimate configuration and the API marshals it
    // as `{}` rather than null. A parser that threw here would turn an empty
    // picker into a broken page.
    expect(parsePlatformSources({ endpoints: {}, entities: {} })).toEqual({
      endpoints: {},
      entities: {},
    });
  });

  it("refuses an absent map rather than treating it as an empty one", () => {
    // These are opposite answers: `{}` means nothing is declared, absent means
    // something other than this route answered.
    expect(() => parsePlatformSources({ entities: {} })).toThrow(PlatformApiError);
    expect(() => parsePlatformSources({ endpoints: {} })).toThrow(/entities is missing/);
  });

  it("refuses a declaration that is not a list of slugs", () => {
    expect(() => parsePlatformSources({ endpoints: { onboarding: "mark8ly" }, entities: {} })).toThrow(
      /endpoints.onboarding is not a list/,
    );
    expect(() => parsePlatformSources({ endpoints: { onboarding: [7] }, entities: {} })).toThrow(
      /not a string/,
    );
  });

  it("refuses a response that is not an object", () => {
    expect(() => parsePlatformSources(null)).toThrow(/response is not an object/);
    expect(() => parsePlatformSources([])).toThrow(/response is not an object/);
  });
});

describe("slugsDeclaring", () => {
  it("returns the declarers in the order the API sorted them", () => {
    const sources = parsePlatformSources({
      endpoints: { onboarding: ["kora", "mark8ly"] },
      entities: {},
    });
    expect(slugsDeclaring(sources, "onboarding")).toEqual(["kora", "mark8ly"]);
  });

  it("treats an endpoint nobody declares as no products, not as an error", () => {
    // Absent and present-but-empty mean the same thing to a caller: nothing to
    // ask. The API omits the key entirely when nobody declares.
    expect(slugsDeclaring(parsePlatformSources(BODY), "inbox")).toEqual([]);
  });
});
