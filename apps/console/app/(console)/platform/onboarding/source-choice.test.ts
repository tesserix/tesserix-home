import { describe, expect, it } from "vitest";
import { PlatformApiError } from "@/lib/platform-api-error";
import {
  chooseSource,
  requestedSource,
  SOURCES_UNREADABLE_MESSAGE,
  sourcesReadError,
  unknownSourceMessage,
} from "./source-choice";

describe("requestedSource", () => {
  it("reads a named source", () => {
    expect(requestedSource({ source: "mark8ly" })).toBe("mark8ly");
  });

  it("treats a blank or repeated source as none asked for", () => {
    expect(requestedSource({ source: "   " })).toBeUndefined();
    expect(requestedSource({ source: ["kora", "mark8ly"] })).toBeUndefined();
    expect(requestedSource({})).toBeUndefined();
  });
});

describe("chooseSource", () => {
  it("defaults to the first declared product, in the API's sorted order", () => {
    // Sorted by the API precisely so two identical deployments — and the two
    // surfaces on one deployment — land on the same default.
    expect(chooseSource(["kora", "mark8ly"], undefined)).toEqual({
      kind: "source",
      source: "kora",
    });
  });

  it("honours a source that declares onboarding", () => {
    expect(chooseSource(["kora", "mark8ly"], "mark8ly")).toEqual({
      kind: "source",
      source: "mark8ly",
    });
  });

  it("refuses a source nobody declares rather than substituting a declared one", () => {
    // The API answers 400 for such a source, so asking would fail anyway — but
    // the reason to refuse is that answering about a DIFFERENT product than
    // the URL names is a lie an operator cannot see.
    expect(chooseSource(["mark8ly"], "shopify")).toEqual({
      kind: "unknown-source",
      requested: "shopify",
      declared: ["mark8ly"],
    });
  });

  it("reports an empty declaration list as such, and never as a product", () => {
    // No fallback slug anywhere: this is the branch a reintroduced
    // FUNNEL_SOURCE would hide.
    expect(chooseSource([], undefined)).toEqual({ kind: "none-declared" });
    expect(chooseSource([], "mark8ly")).toEqual({ kind: "none-declared" });
  });
});

describe("unknownSourceMessage", () => {
  it("names both what was asked for and what is available", () => {
    const message = unknownSourceMessage("shopify", ["kora", "mark8ly"]);
    expect(message).toContain("shopify");
    expect(message).toContain("kora, mark8ly");
  });
});

describe("sourcesReadError", () => {
  it("names the read, not a product — there is no product to name", () => {
    const error = sourcesReadError(new PlatformApiError("sources: 503", 503));
    expect(error?.message).toBe(SOURCES_UNREADABLE_MESSAGE);
    expect(error?.message).not.toContain("mark8ly");
  });

  it("keeps the sign-in-again marker, which has a remedy the outage copy lacks", () => {
    const error = sourcesReadError(
      new PlatformApiError("no token", undefined, { noOperatorToken: true }),
    );
    expect(error?.reauthRequired).toBe(true);
  });

  it("passes a clean read through as no error at all", () => {
    expect(sourcesReadError(null)).toBeNull();
  });
});
