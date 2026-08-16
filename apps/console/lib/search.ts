import {
  consolePath,
  isPending,
  ROUTE_IDS,
  type RouteId,
  INTERNAL_TOOLS,
  type InternalTool,
  toolUrl,
  routeCapability,
} from "@tesserix/console-core";
import type { Capability } from "@tesserix/platform-auth";

/**
 * The command palette's search domain.
 *
 * One `SearchEntry` shape covers three unrelated sources — the route table,
 * the internal tools directory and server-matched ticket rows — so the
 * palette (Task 2/3) can render and filter a single flat list instead of
 * branching on source everywhere it touches an item.
 */

export type SearchKind = "route" | "tool" | "ticket";

export interface SearchEntry {
  readonly id: string;
  readonly kind: SearchKind;
  readonly label: string;
  readonly hint: string;
  readonly href: string;
  readonly external: boolean;
  readonly disabled: boolean;
  readonly keywords: readonly string[];
  /**
   * The capability an operator must hold to SEE this entry.
   *
   * `Capability`, not `string`: when this was a bare `string`, all three
   * builders could sit on the same hardcoded "read" — the console entry
   * ticket everyone holds — and `visibleTo` filtered against a constant
   * without anything complaining. The narrow type does not by itself stop a
   * constant, but it does stop a typo, and it makes the value's provenance
   * (the Zitadel role contract) legible at the field.
   */
  readonly capability: Capability;
}

/**
 * A row from the platform-tickets search endpoint.
 *
 * Field names match the API's snake_case wire shape rather than the
 * camelCase `Ticket` type in `tickets.ts` — this is a narrower, search-result
 * shape, not the full ticket, and keeping the wire names avoids a mapping
 * step in the one place that only needs to build a `SearchEntry`.
 */
export interface TicketSearchRow {
  id: string;
  product_id: string;
  ticket_number: string;
  subject: string;
  submitted_by_name: string;
  submitted_by_email: string;
  status: string;
}

/**
 * A query shorter than this would scan `platform_tickets` on every keystroke
 * for a match nobody typed yet. Two characters is the first point a search is
 * meaningfully narrower than "everything".
 */
export const MIN_TICKET_QUERY = 2;

/**
 * Splits a camelCase route id segment into words and capitalizes it, e.g.
 * "breakGlass" -> "Break Glass", "tickets" -> "Tickets".
 *
 * Exported so `lib/trail.ts` can label an ancestor crumb with the same
 * word-split and capitalization the palette applies to its own labels — a
 * second copy of this one-liner would only drift from this one. The split
 * happens here, not at render time, so the displayed label and the value
 * `CommandItem` filters on are the same string: an operator who reads
 * "Break Glass" on screen and types "break glass" must find it.
 */
export function routeSegmentLabel(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Turns a dotted route id into a display label, e.g. `platform.tickets` ->
 * "Platform · Tickets".
 */
export function routeLabel(id: RouteId): string {
  return id.split(".").map(routeSegmentLabel).join(" · ");
}

/**
 * Every route as a search entry, pending ones included and marked disabled.
 *
 * Pending routes still need to be discoverable: hiding 21 of 22 routes would
 * leave the palette looking like the console has one page, and an operator
 * searching for a route that is on the roadmap but not built deserves "not
 * yet" rather than "not found".
 *
 * Capability comes from the route table, not from here: which capability a
 * surface needs is part of its identity, and a second mapping in this file
 * would drift from the one in `console-core`. Most routes resolve to the
 * `read` default; the handful that do not are the ones an operator without
 * them must not see advertised.
 */
export function routeEntries(): SearchEntry[] {
  return ROUTE_IDS.map((id) => {
    const [first, second] = id.split(".");
    return {
      id: `route:${id}`,
      kind: "route",
      label: routeLabel(id),
      hint: "",
      href: consolePath(id),
      external: false,
      disabled: isPending(id),
      keywords: [id, first, second].filter((part): part is string => Boolean(part)),
      capability: routeCapability(id),
    };
  });
}

function toolKeywords(tool: InternalTool): readonly string[] {
  return [tool.name, tool.subdomain, tool.group];
}

function toolHint(tool: InternalTool): string {
  return tool.note ? `${tool.purpose} ${tool.note}` : tool.purpose;
}

/**
 * Every internal tool as a search entry, linking out to `baseDomain`.
 *
 * Always external and always enabled: these are plain links to hosts the
 * console does not own, so there is no "pending" state to represent.
 *
 * `read` here is deliberate, not the oversight the routes carried. These are
 * outbound links to Grafana, Zitadel and the like; the console grants nothing
 * by naming them, and each tool enforces its own authorization on arrival.
 * Hiding a link the operator may well be able to open would be a worse guess
 * than showing it.
 */
export function toolEntries(baseDomain: string): SearchEntry[] {
  return INTERNAL_TOOLS.map((tool) => ({
    id: `tool:${tool.subdomain}`,
    kind: "tool",
    label: tool.name,
    hint: toolHint(tool),
    href: toolUrl(tool, baseDomain),
    external: true,
    disabled: false,
    keywords: toolKeywords(tool),
    capability: "read", // deliberate — see the doc comment above

  }));
}

/**
 * One server-matched ticket row as a search entry.
 *
 * Links by `id` (a stable uuid), never by `ticket_number` — ticket numbers
 * are scoped per product and are not guaranteed unique across the queue.
 *
 * `read` is deliberate and matches `platform.tickets`: a ticket is readable by
 * anyone who can read the queue it came from. Replying to it needs `respond`,
 * but that is asserted at the action on the detail surface, not at the search
 * result — an operator who can read a ticket should be able to find it.
 */
export function ticketEntry(row: TicketSearchRow): SearchEntry {
  return {
    id: `ticket:${row.id}`,
    kind: "ticket",
    label: `${row.ticket_number} — ${row.subject}`,
    hint: `${row.submitted_by_name} · ${row.status}`,
    href: `/platform/tickets/${row.id}`,
    external: false,
    disabled: false,
    keywords: [
      row.ticket_number,
      row.subject,
      row.submitted_by_name,
      row.submitted_by_email,
      row.product_id,
    ],
    capability: "read", // deliberate — see the doc comment above

  };
}

/**
 * Filters entries down to what an operator's held capabilities allow.
 *
 * Fails closed when `enforce` is true: an `undefined` or empty `held` hides
 * everything rather than falling back to "show it anyway", because a bug that
 * drops the claims list must not silently turn into full access. When
 * `enforce` is false — the legacy provider carries no capability claims at
 * all — filtering on an absent claim would empty the palette for every
 * operator, so entries pass through unchanged.
 */
export function visibleTo(
  entries: readonly SearchEntry[],
  held: readonly string[] | undefined,
  enforce: boolean,
): SearchEntry[] {
  if (!enforce) {
    return [...entries];
  }
  const heldSet = new Set(held ?? []);
  return entries.filter((entry) => heldSet.has(entry.capability));
}
