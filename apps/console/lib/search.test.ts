import { describe, expect, it } from "vitest";
import {
  MIN_TICKET_QUERY,
  routeEntries,
  ticketEntry,
  toolEntries,
  visibleTo,
  type SearchEntry,
} from "./search";

describe("routeEntries", () => {
  it("marks pending routes disabled so they render but cannot be opened", () => {
    // 21 of 22 routes are pending today. Hiding them would leave the palette
    // looking empty; offering them would 404.
    const entries = routeEntries();
    const pending = entries.filter((e) => e.disabled);
    expect(pending.length).toBeGreaterThan(0);
    expect(entries.some((e) => !e.disabled)).toBe(true);
  });

  it("points the built ticket queue at its console path", () => {
    const tickets = routeEntries().find((e) => e.id === "route:platform.tickets");
    expect(tickets).toBeDefined();
    expect(tickets?.disabled).toBe(false);
    expect(tickets?.href).toBe("/platform/tickets");
    expect(tickets?.external).toBe(false);
  });

  it("gives every route a searchable label derived from its id", () => {
    const tickets = routeEntries().find((e) => e.id === "route:platform.tickets");
    expect(tickets?.label.toLowerCase()).toContain("tickets");
    expect(tickets?.keywords.join(" ")).toContain("platform.tickets");
  });
});

describe("toolEntries", () => {
  it("builds an absolute external URL from the base domain", () => {
    const entries = toolEntries("tesserix.app");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.external).toBe(true);
      expect(entry.href.startsWith("https://")).toBe(true);
      expect(entry.disabled).toBe(false);
    }
  });

  it("carries the tool's purpose as the hint, so a name nobody knows is explained", () => {
    const entries = toolEntries("tesserix.app");
    expect(entries.every((e) => e.hint.length > 0)).toBe(true);
  });
});

describe("ticketEntry", () => {
  const ROW = {
    id: "5f0b2c34-0000-0000-0000-000000000000",
    product_id: "mark8ly",
    ticket_number: "M8-1042",
    subject: "Payout missing",
    submitted_by_name: "Asha Pillai",
    submitted_by_email: "asha@example.com",
    status: "open",
  };

  it("links by uuid, never by ticket number", () => {
    expect(ticketEntry(ROW).href).toBe(
      "/platform/tickets/5f0b2c34-0000-0000-0000-000000000000",
    );
  });

  it("carries every server-matched field as a keyword", () => {
    // CommandItem self-filters on value + keywords with no escape hatch, so a
    // ticket the server matched would be hidden client-side unless the text
    // it matched on travels with it.
    const kw = ticketEntry(ROW).keywords.join(" ").toLowerCase();
    expect(kw).toContain("m8-1042");
    expect(kw).toContain("payout missing");
    expect(kw).toContain("asha pillai");
    expect(kw).toContain("asha@example.com");
  });
});

describe("visibleTo", () => {
  const ENTRIES: SearchEntry[] = [
    {
      id: "a",
      kind: "route",
      label: "A",
      hint: "",
      href: "/a",
      external: false,
      disabled: false,
      keywords: [],
      capability: "read",
    },
    {
      id: "b",
      kind: "route",
      label: "B",
      hint: "",
      href: "/b",
      external: false,
      disabled: false,
      keywords: [],
      capability: "hard-delete",
    },
  ];

  it("drops entries whose capability the operator does not hold", () => {
    expect(visibleTo(ENTRIES, ["read"], true).map((e) => e.id)).toEqual(["a"]);
  });

  it("keeps everything when enforcement is off, as under the legacy provider", () => {
    // Legacy sessions carry no roles at all; filtering on an absent claim
    // would empty the palette for everyone.
    expect(visibleTo(ENTRIES, undefined, false)).toHaveLength(2);
  });

  it("drops everything when enforcement is on and no capabilities are held", () => {
    expect(visibleTo(ENTRIES, [], true)).toHaveLength(0);
  });
});

describe("MIN_TICKET_QUERY", () => {
  it("is two, so a single character does not scan the table", () => {
    expect(MIN_TICKET_QUERY).toBe(2);
  });
});
