import { describe, expect, it } from "vitest";
import { ROUTE_IDS } from "@tesserix/console-core";
import type { DirectoryTool } from "@/lib/tools-directory";
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
    // 20 of 22 routes are pending today. Hiding them would leave the palette
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

  it("splits a camelCase segment into the words its label displays", () => {
    // Regression test: routeSegmentLabel used to capitalize only, leaving
    // the split to a render-time-only helper in command-palette.tsx. That
    // meant `value` (built from the unsplit label) never matched what an
    // operator reads on screen and types back in.
    const breakGlass = routeEntries().find((e) => e.id === "route:platform.breakGlass");
    expect(breakGlass?.label).toBe("Platform · Break Glass");
  });

  it("keeps the raw dotted route id in keywords alongside the split label", () => {
    const breakGlass = routeEntries().find((e) => e.id === "route:platform.breakGlass");
    expect(breakGlass?.keywords).toContain("platform.breakGlass");
  });

  it("carries each route's declared capability rather than a constant", () => {
    // The bug this replaced: all three builders hardcoded "read", the entry
    // ticket every internal operator holds, so `visibleTo` filtered against a
    // constant and could only hide everything or nothing.
    const entries = routeEntries();
    const breakGlass = entries.find((e) => e.id === "route:platform.breakGlass");
    const dashboard = entries.find((e) => e.id === "route:platform.dashboard");
    expect(breakGlass?.capability).toBe("rotate-credentials");
    // `platform`, not `read`. Under #261 an ordinary route carries its SURFACE;
    // if this ever reads `read` again the constant-filter bug is back, because
    // `read` is the ticket every operator holds.
    expect(dashboard?.capability).toBe("platform");
  });

  it("surfaces the identity lookup but refuses to navigate to it", () => {
    // #134. Every ROUTE_ID becomes a palette entry automatically, so adding
    // the route id put this in the command palette without anyone choosing to
    // — which is right (an operator searching "identity" deserves "not yet"
    // rather than "not found") but only if it lands DISABLED. There is no
    // lookup surface in the console, and no way to build one until the console
    // holds a Zitadel Management API credential.
    const lookup = routeEntries().find(
      (e) => e.id === "route:platform.identityLookup",
    );
    expect(lookup).toBeDefined();
    expect(lookup?.disabled).toBe(true);
    expect(lookup?.external).toBe(false);
    // Never the /admin path: `pending` or not, the palette must not hand an
    // operator a link into the app being retired.
    expect(lookup?.href).not.toMatch(/^\/admin\//);
  });

  it("labels the identity lookup in words an operator would type", () => {
    // `routeLabel` splits the camelCase segment, so the id reads as prose.
    // "Platform · Identity" would have been ambiguous with IdP configuration;
    // this is why the route id is `identityLookup` and not `identity`.
    const lookup = routeEntries().find(
      (e) => e.id === "route:platform.identityLookup",
    );
    expect(lookup?.label).toBe("Platform · Identity Lookup");
    expect(lookup?.keywords).toContain("platform.identityLookup");
  });

  it("still emits exactly one entry per route id", () => {
    // The capability field must not add or drop palette entries.
    const entries = routeEntries();
    expect(entries.length).toBe(ROUTE_IDS.length);
    expect(new Set(entries.map((e) => e.id)).size).toBe(ROUTE_IDS.length);
  });
});

describe("routeEntries under capability enforcement", () => {
  it("hides a route whose capability the operator does not hold", () => {
    // A support operator: holds the surface, not the destructive verb.
    const support = visibleTo(routeEntries(), ["read", "support"], true);
    expect(support.some((e) => e.id === "route:platform.breakGlass")).toBe(false);
    // and their own surface is still there — this is not "hide everything"
    expect(support.some((e) => e.id === "route:platform.tickets")).toBe(true);
  });

  it("shows an operator holding only console entry nothing at all", () => {
    // #261's point, made visible. `read` is now entry and nothing else, so a
    // `read`-only session reaches the shell and no feature surface. Before, it
    // saw every route, because 26 of 30 defaulted to exactly this capability.
    const entryOnly = visibleTo(routeEntries(), ["read"], true);

    expect(entryOnly).toEqual([]);
  });

  it("shows a CRM operator the CRM and not the ticket queue", () => {
    const crm = visibleTo(routeEntries(), ["read", "crm"], true);

    expect(crm.some((e) => e.id === "route:platform.crmOrganisations")).toBe(true);
    expect(crm.some((e) => e.id === "route:platform.tickets")).toBe(false);
  });

  it("shows it to an operator who holds that capability", () => {
    const rotator = visibleTo(routeEntries(), ["read", "platform", "rotate-credentials"], true);
    expect(rotator.some((e) => e.id === "route:platform.breakGlass")).toBe(true);
  });
});

describe("toolEntries", () => {
  const rows: DirectoryTool[] = [
    { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity platform.", note: null, groupKey: "identity" },
    { id: "2", name: "Kargo", subdomain: "kargo", purpose: "Promotes images.", note: null, groupKey: "delivery" },
  ];

  it("builds an entry per supplied row rather than from the code literal", () => {
    const entries = toolEntries("tesserix.app", rows);

    // The whole point of the cutover: a tool added through CRUD is findable in
    // the palette the same minute. Reading INTERNAL_TOOLS here would have
    // meant the cards showed reality and the palette showed 2026.
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual(["Zitadel", "Kargo"]);
  });

  it("derives the href from the base domain", () => {
    const entries = toolEntries("dev.tesserix.app", rows);

    expect(entries[0].href).toBe("https://auth.dev.tesserix.app");
  });

  it("returns nothing when the directory is empty", () => {
    expect(toolEntries("tesserix.app", [])).toEqual([]);
  });

  it("builds an absolute external URL from the base domain", () => {
    const entries = toolEntries("tesserix.app", rows);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.external).toBe(true);
      expect(entry.href.startsWith("https://")).toBe(true);
      expect(entry.disabled).toBe(false);
    }
  });

  it("carries the tool's purpose as the hint, so a name nobody knows is explained", () => {
    const entries = toolEntries("tesserix.app", rows);
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
