import { describe, expect, it } from "vitest";
import { ancestorTrail } from "./trail";

describe("ancestorTrail", () => {
  it("is empty on a top-level surface, which has no ancestors", () => {
    expect(ancestorTrail("/platform/tickets")).toEqual([]);
  });

  it("is empty at the root", () => {
    expect(ancestorTrail("/")).toEqual([]);
  });

  it("names the parent queue from a ticket detail path", () => {
    // The leaf is a uuid and stays out of the trail — only the page knows it
    // is really M8-1042.
    expect(ancestorTrail("/platform/tickets/5f0b2c34-0000-0000-0000-000000000000")).toEqual([
      { label: "Tickets", href: "/platform/tickets" },
    ]);
  });

  it("tolerates a trailing slash", () => {
    expect(
      ancestorTrail("/platform/tickets/5f0b2c34-0000-0000-0000-000000000000/"),
    ).toHaveLength(1);
  });

  it("omits an ancestor that is not a built route", () => {
    // A crumb pointing at a pending surface would 404. Better absent than
    // broken — the same rule the palette applies to its results.
    expect(ancestorTrail("/platform/break-glass/some-id")).toEqual([]);
  });

  it("returns nothing for a path that matches no known route", () => {
    expect(ancestorTrail("/nonsense/deep/path")).toEqual([]);
  });
});
