import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ESTATE } from "@tesserix/console-core";
import { EstateMap } from "./estate-map";

// This board's stated job is being honest about what has actually moved, so
// its failure mode is not a crash — it is a confident sentence that is not
// true. `entries === 0` already has bespoke copy for exactly that reason ("0
// rail entries · still in apps/web" would be wrong twice over). These tests
// cover the case that arrived with tesserix-home#406: a rail scaffolded in
// console-core whose entries are counted from `mark8lyNav`, while `migrated`
// is still false because the rail has not shipped.

describe("EstateMap", () => {
  it("does not claim a console-core-counted rail still lives in apps/web", () => {
    // Mark8ly's `entries` is `mark8lyNav.length`, checked in console-core's own
    // suite. Its single entry is `pending`, and `routes.ts` is explicit that a
    // pending entry links NOWHERE — "not in-app (the page does not exist) and
    // not to apps/web either". So "· still in apps/web" would be false about a
    // count that did not come from apps/web and does not point there.
    render(<EstateMap />);

    const mark8ly = ESTATE.find((product) => product.context === "mark8ly");
    expect(mark8ly?.entriesFrom).toBe("console-core");

    const card = screen.getByRole("heading", { name: "Mark8ly" }).closest("li");
    expect(card).not.toBeNull();
    expect(card?.textContent).not.toContain("still in apps/web");
  });

  it("says a scaffolded rail is not yet live, rather than implying it ships", () => {
    // The third state has to be distinguishable from `migrated` too: "in
    // console-core" on a rail nobody can reach would be the same false claim
    // with the opposite sign.
    render(<EstateMap />);

    const card = screen.getByRole("heading", { name: "Mark8ly" }).closest("li");
    expect(card?.textContent).toContain("not yet live");
  });

  it("still says apps/web for a product whose rail really is there", () => {
    // The regression guard on the fix: every other unmigrated product counts
    // its entries from apps/web and must keep saying so. Fe3dr is the largest
    // such rail, so it is the one a broken default would be most visible on.
    render(<EstateMap />);

    const fe3dr = ESTATE.find((product) => product.context === "homechef");
    expect(fe3dr?.migrated).toBe(false);
    expect(fe3dr?.entriesFrom).toBeUndefined();

    const card = screen.getByRole("heading", { name: "Fe3dr" }).closest("li");
    expect(card?.textContent).toContain("still in apps/web");
  });

  it("still marks a migrated product as living in console-core", () => {
    render(<EstateMap />);

    const card = screen.getByRole("heading", { name: "Kora" }).closest("li");
    expect(card?.textContent).toContain("in console-core");
    expect(card?.textContent).not.toContain("not yet live");
  });
});
