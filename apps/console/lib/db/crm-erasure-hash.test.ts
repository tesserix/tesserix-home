import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeContactEmail, normalizeInstagramHandle } from "./crm-identity";
import {
  ERASURE_HASH_KEY_ENV,
  ErasureHashKeyMissingError,
  erasureHashes,
  isErasureHashKeyConfigured,
} from "./crm-erasure-hash";

/**
 * The erasure hash's own properties (#226). The end-to-end claim — an erased
 * contact is refused by the next import — lives in
 * `crm-erasure-import.integration.test.ts`; this file pins the things that
 * make it possible, and one of them is worth stating plainly:
 *
 * every failure this module can have is SILENT. A hash that disagrees with
 * the one the import computes does not throw, does not log, and does not
 * fail a shape assertion — the import simply matches nothing and re-creates
 * the person, exactly as it did before the fix, while reporting
 * `skippedErased: 0` as though it had checked. So the agreement between the
 * two sides is asserted here against the REAL normalisers, not against a
 * hardcoded digest that would keep passing if `normalizeContactEmail` changed
 * underneath it.
 */

const KEY = "test-erasure-key-not-a-real-one";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("erasureHashes", () => {
  it("derives its input from the SAME normalisers findMatchingOrganisationId matches with", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);

    // Recomputed here from the real, imported normalisers — so if either one
    // changes, this expectation changes with it and the test keeps meaning
    // "the hash agrees with the lookup" rather than "the hash is this
    // particular string".
    const expectedEmail = createHmac("sha256", KEY)
      .update(`email:${normalizeContactEmail(" Foo@Example.COM ")}`)
      .digest("hex");
    const expectedHandle = createHmac("sha256", KEY)
      .update(`ig:${normalizeInstagramHandle("@BondiBaker")}`)
      .digest("hex");

    expect(erasureHashes({ email: " Foo@Example.COM " })).toEqual([expectedEmail]);
    expect(erasureHashes({ instagramHandle: "@BondiBaker" })).toEqual([expectedHandle]);
  });

  it("hashes a messy recorded value and a clean incoming one to the same digest", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);

    // The scenario in one assertion: the erasure read `" Foo@Example.COM "`
    // off a contact row, the re-import carries `foo@example.com` from a
    // different scrape. A trailing space between these two is the whole
    // difference between a feature and a no-op.
    const recorded = erasureHashes({ email: " Foo@Example.COM " });
    const incoming = erasureHashes({ email: "foo@example.com" });
    expect(incoming).toEqual(recorded);

    const recordedHandle = erasureHashes({ instagramHandle: "  @BondiBaker " });
    const incomingHandle = erasureHashes({ instagramHandle: "bondibaker" });
    expect(incomingHandle).toEqual(recordedHandle);
  });

  it("hashes email and handle separately, one digest each", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);

    // Two rows, not one combined digest: a person who comes back under only
    // one of their two identifiers still has to be caught, and a combined
    // hash would only ever match the exact same pair.
    const both = erasureHashes({ email: "ava@example.com", instagramHandle: "bondibaker" });
    expect(both).toHaveLength(2);
    expect(both).toEqual([
      ...erasureHashes({ email: "ava@example.com" }),
      ...erasureHashes({ instagramHandle: "bondibaker" }),
    ]);
  });

  it("namespaces the two kinds so the same text does not collide across them", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);

    const asEmail = erasureHashes({ email: "bondibaker" });
    const asHandle = erasureHashes({ instagramHandle: "bondibaker" });
    expect(asEmail[0]).not.toBe(asHandle[0]);
  });

  it("produces a different digest under a different key", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);
    const underOne = erasureHashes({ email: "ava@example.com" })[0];
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "a-completely-different-key");
    const underAnother = erasureHashes({ email: "ava@example.com" })[0];

    // The point of keying it: a dump of `crm_erased_identifiers` plus a
    // scrape confirms nothing without the key. Also the reason rotating the
    // key is not a routine operation — every recorded hash stops matching.
    expect(underAnother).not.toBe(underOne);
  });

  it("treats a blank or absent identifier as nothing to record", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);

    // A hash of the empty string would be recorded once and then refuse
    // every future row whose email cell is blank.
    expect(erasureHashes({})).toEqual([]);
    expect(erasureHashes({ email: null, instagramHandle: null })).toEqual([]);
    expect(erasureHashes({ email: "   ", instagramHandle: " @ " })).toEqual([]);
  });

  it("throws rather than returning nothing when the key is unset", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");

    // Silence here would hand BOTH callers the fail-open: an erasure that
    // reports success while recording nothing, and an import that reports
    // `skippedErased: 0` without having looked.
    expect(() => erasureHashes({ email: "ava@example.com" })).toThrow(ErasureHashKeyMissingError);
    expect(isErasureHashKeyConfigured()).toBe(false);
  });

  it("names the environment variable in the error, and no personal data", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");

    // The message reaches an operator through `crm-write.ts`'s mapError, so
    // it has to say what to set — and must not echo back the address it was
    // asked to hash.
    let message = "";
    try {
      erasureHashes({ email: "ava@example.com" });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain(ERASURE_HASH_KEY_ENV);
    expect(message).not.toContain("ava@example.com");
  });

  it("reads the key at call time, so provisioning it does not need a restart", () => {
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");
    expect(isErasureHashKeyConfigured()).toBe(false);
    vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);
    expect(isErasureHashKeyConfigured()).toBe(true);
  });
});
