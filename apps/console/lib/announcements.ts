// Platform announcements, as the console reads and authors them (#150).
//
// The wire shape is the platform API's AUTHORING view — richer than the one
// products receive, which deliberately omits audience_filter, is_published and
// created_by. An operator needs all three: they are the targeting, the draft
// state and the attribution.

/** The four values the schema's CHECK constraint permits. */
export const SEVERITIES = ["info", "warning", "maintenance", "incident"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  starts_at: string;
  ends_at: string | null;
  audience_filter: Record<string, unknown>;
  is_published: boolean;
  created_by?: string;
  updated_at: string;
}

/**
 * Why an audience could not be counted.
 *
 * Three distinct reasons, kept apart because an operator does something
 * different about each: `not_federated` never becomes countable, `unavailable`
 * is worth retrying, and `exceeds_limit` means the figure shown is a floor.
 */
export type UncountableReason = "not_federated" | "unavailable" | "exceeds_limit";

export interface AudienceEntry {
  product: string;
  countable: boolean;
  count: number;
  reason?: UncountableReason;
  counted_at_least?: number;
}

export interface Audience {
  audience: AudienceEntry[];
  countable_total: number;
  /**
   * True when any product's share is unknown.
   *
   * The reason this field exists rather than being derived at each call site:
   * `countable_total` on its own reads as "the audience", and rendering it
   * that way next to a send button is the precise failure #150 asks to avoid.
   */
  has_uncountable: boolean;
}

/** A tenant lifecycle status, as a product reports it. */
export type TenantStatus = string;

/**
 * Read the targeting out of an announcement's audience_filter.
 *
 * The filter is deliberately schemaless — the migration calls it
 * "intentionally permissive so we can grow filters without a migration" — so
 * this reads the two keys the query actually matches on and ignores the rest
 * rather than failing on a filter someone grew.
 */
export function targeting(filter: Record<string, unknown>): {
  products: string[];
  statuses: TenantStatus[];
} {
  return { products: stringList(filter.products), statuses: stringList(filter.statuses) };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Is this announcement live right now?
 *
 * Published AND inside its window — the same three conditions the read query
 * applies. Computed here rather than sent, because a row's liveness changes
 * with the clock and a field would be stale the moment it was serialised.
 */
export function isLive(a: Announcement, now: Date = new Date()): boolean {
  if (!a.is_published) return false;
  if (new Date(a.starts_at) > now) return false;
  return a.ends_at === null || new Date(a.ends_at) > now;
}

/** How an announcement's state reads to an operator scanning the list. */
export function state(a: Announcement, now: Date = new Date()): "draft" | "scheduled" | "live" | "ended" {
  if (!a.is_published) return "draft";
  if (new Date(a.starts_at) > now) return "scheduled";
  if (a.ends_at !== null && new Date(a.ends_at) <= now) return "ended";
  return "live";
}
