import { describe, expect, it } from "vitest";
import {
  ESTATE,
  allowsEndUserLookup,
  declaresEndUserLookup,
  endUserLookupProducts,
  unmigrated,
} from "./estate";
import { koraNav, mark8lyNav } from "./nav";

describe("estate", () => {
  it("covers every rail context apps/web defines", () => {
    // apps/web's RailContext union, as of 2026-08-15. If a product is added
    // there and not here, the console's estate view silently omits it.
    //
    // A SUBSET check, not equality: ESTATE is deliberately larger. HMS is in
    // the estate with no apps/web rail at all, which is the fact worth
    // carrying — it is the one product where console decisions can still shape
    // the product rather than retrofit it.
    const contexts = new Set(ESTATE.map((p) => p.context));
    for (const rail of [
      "devai",
      "dwellm8",
      "homechef",
      "kora",
      "mark8ly",
      "platform",
    ]) {
      expect(contexts, `apps/web rail "${rail}" missing from ESTATE`).toContain(
        rail,
      );
    }
  });

  it("carries HMS as a product with no rail yet", () => {
    // Zero entries is the point, not an oversight: HMS has no console presence.
    // Recording it as absent-with-zero rather than omitting it keeps the gap
    // visible on the estate map.
    const hms = ESTATE.find((p) => p.context === "hms");
    expect(hms).toBeDefined();
    expect(hms?.entries).toBe(0);
    expect(hms?.migrated).toBe(false);
  });

  it("keeps Kora's entry count honest against the nav it actually ships", () => {
    // Kora is the one migrated product, so its count is checkable rather than
    // transcribed — this is the entry that would rot first if koraNav changed.
    const kora = ESTATE.find((p) => p.context === "kora");
    expect(kora?.entries).toBe(koraNav.length);
  });

  it("keeps Mark8ly's entry count honest against the nav it actually ships", () => {
    // The same guard Kora has, and for the reason #405 found the hard way: the
    // literal `8` sat here for a fortnight beside a comment citing an issue
    // that had since closed, and nothing was checking either. A count derived
    // from the rail cannot go stale on its own — only the rail can change, and
    // then this is what says so.
    //
    // Mark8ly is NOT migrated, unlike Kora, so this pins a smaller claim: the
    // number equals the rail console-core declares. See estate.ts's Mark8ly
    // comment for what that number now means and what it stopped meaning.
    const mark8ly = ESTATE.find((p) => p.context === "mark8ly");
    expect(mark8ly?.entries).toBe(mark8lyNav.length);
    // Guards the guard: an empty rail on both sides would satisfy the line
    // above. Five since #588 — the three generic `[product]` surfaces, plus
    // two rows that are still pending: the email template editor and the
    // migration fast-path queue.
    // Still not §2.3's three: see nav.ts for why arbitrage appeals and app
    // credentials are deferred rather than forgotten.
    expect(mark8lyNav).toHaveLength(5);
  });

  it("declares the contracts Mark8ly's rail renders from, and nothing for anyone else", () => {
    // `contracts` is the D4 mechanism: absence means the product declares
    // none, the same absence-means-no shape `endUserLookup` uses. Asserted
    // over the WHOLE estate rather than on Mark8ly alone, so a product that
    // picks up a declaration without a rail to render it fails here.
    const declaring = ESTATE.filter((p) => p.contracts !== undefined);
    expect(declaring.map((p) => p.name)).toEqual(["Mark8ly"]);
    expect(declaring[0]?.contracts).toEqual(["inbox"]);
  });

  it("reports exactly one product as migrated today", () => {
    expect(ESTATE.filter((p) => p.migrated).map((p) => p.name)).toEqual(["Kora"]);
    // Derived from ESTATE rather than hardcoded: a count that has to be edited
    // every time a product is added is a count that gets edited without being
    // read, which is how the DevAI and Dwellm8 summaries went stale.
    expect(unmigrated()).toHaveLength(ESTATE.length - 1);
  });

  it("defaults end-user lookup to false for every product without exception", () => {
    // Over the WHOLE list, not a sample. A sample only covers the products
    // someone thought to name, and the product that gets missed is the one
    // added last — exactly when nobody is thinking about end-user lookup.
    for (const product of ESTATE) {
      expect(
        allowsEndUserLookup(product.context),
        `${product.name} declares end-user lookup; it must be reviewed, not defaulted`,
      ).toBe(false);
    }
    // And the list is non-empty, so the loop above cannot pass vacuously.
    expect(ESTATE.length).toBeGreaterThan(0);
  });

  it("declares no end-user lookup anywhere in the estate today", () => {
    // The statement of intent. v1 returns staff and operators only, so the
    // correct number of products serving end-user rows is zero.
    //
    // This is the test that must be EDITED, not just observed to pass, on the
    // day a product opts in — which is the point. Flipping `endUserLookup` on
    // one product turns this red, so the change cannot land without someone
    // coming here and naming the product in the expected list.
    expect(endUserLookupProducts().map((p) => p.name)).toEqual([]);
  });

  it("fails closed for a context it has never heard of", () => {
    // "We do not know this product" and "this product has not opted in" get
    // the same answer. A permissive fallback here would mean a typo in a rail
    // context reads as consent.
    expect(allowsEndUserLookup("fanzone")).toBe(false);
    expect(allowsEndUserLookup("")).toBe(false);
  });

  it("returns false for HMS by absence, not by a special case", () => {
    // Guards the guard, and it is the one assertion that would survive the
    // field being deleted — so it checks the FIELD, not just the answer.
    //
    // Every assertion above still passes if `endUserLookup` is removed from
    // the interface and `allowsEndUserLookup` is reduced to `return false`:
    // false is false. These two lines fail on that refactor. The accessor must
    // be reading a real, optional, declarable field — proven by constructing
    // an entry that declares `true` and watching the same predicate flip.
    const hms = ESTATE.find((p) => p.context === "hms");
    expect(hms).toBeDefined();
    expect(hms?.endUserLookup).toBeUndefined();

    // Same predicate, same product, one field changed — immutably, so ESTATE
    // is untouched. It must answer differently, which it can only do by
    // reading the field.
    expect(declaresEndUserLookup(hms!)).toBe(false);
    expect(declaresEndUserLookup({ ...hms!, endUserLookup: true })).toBe(true);
    // And the real estate is unchanged by having asked.
    expect(endUserLookupProducts()).toHaveLength(0);
    expect(allowsEndUserLookup("hms")).toBe(false);
  });

  it("separates display name from rail context", () => {
    // Fe3dr is the case that breaks a naive "name === context" assumption.
    const fe3dr = ESTATE.find((p) => p.name === "Fe3dr");
    expect(fe3dr?.context).toBe("homechef");
  });
});
