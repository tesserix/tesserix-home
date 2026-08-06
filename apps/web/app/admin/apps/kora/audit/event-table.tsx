import Link from "next/link";

import type { KoraAdminEvent } from "@/lib/api/kora-admin";

// Fields whose change is worth showing in a diff. The audit row's before/after
// snapshots carry more than this (normalized_name, has_embedding, created_at),
// but those are DERIVED — normalized_name follows name, has_embedding follows a
// rename clearing the vector — so showing them would report one operator edit
// as three or four changes and bury the one that was actually made.
const DIFFABLE_FIELDS = [
  "name",
  "brand",
  "provenance",
  "barcode",
  "serving_desc",
  "serving_grams",
  "kcal_per_100g",
  "protein_per_100g",
  "carbs_per_100g",
  "fat_per_100g",
  "fiber_per_100g",
  "deleted_at",
] as const;

const ACTION_LABEL: Record<string, string> = {
  "food.created": "Created",
  "food.updated": "Edited",
  "food.deleted": "Retired",
};

interface FieldChange {
  field: string;
  before: string;
  after: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/**
 * Computes the human-readable diff between an event's before/after snapshots.
 *
 * Both snapshots are `unknown` off the wire and either may be absent — a
 * create has no `before`, and a row written by a future action might have
 * neither. Each case is handled rather than assumed, because a crash in the
 * audit table would take down the page whose entire job is to show what
 * happened.
 */
export function diffEvent(event: KoraAdminEvent): FieldChange[] {
  const before = asRecord(event.before);
  const after = asRecord(event.after);
  if (!before && !after) return [];

  const changes: FieldChange[] = [];
  for (const field of DIFFABLE_FIELDS) {
    const b = before?.[field];
    const a = after?.[field];
    // Compare rendered values, not raw ones: kora serialises numbers as JSON
    // numbers but a value that round-trips through jsonb can come back as
    // 40 vs 40.0, and reporting "serving_grams 40 → 40" as a change is noise
    // that makes the real edit harder to find.
    const rb = render(b);
    const ra = render(a);
    if (rb !== ra) changes.push({ field, before: rb, after: ra });
  }
  return changes;
}

/**
 * The audit table, shared by the full trail and a single food's history so the
 * two can never render the same event differently.
 */
export function EventTable({
  events,
  emptyLabel,
}: {
  events: KoraAdminEvent[];
  emptyLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Food</th>
              <th className="px-4 py-3">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              events.map((event) => {
                const changes = diffEvent(event);
                return (
                  <tr key={event.id} className="align-top hover:bg-muted/30">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(event.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-foreground">{event.actor_email}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-foreground">
                      {ACTION_LABEL[event.action] ?? event.action}
                    </td>
                    <td className="px-4 py-3">
                      {event.target_id ? (
                        <Link
                          href={`/admin/apps/kora/foods/${event.target_id}`}
                          className="text-foreground underline"
                        >
                          {/* The snapshot's name, not the live row's: an audit
                              entry must show what the food was CALLED at the
                              time, or a later rename rewrites history. */}
                          {render(asRecord(event.after)?.name ?? asRecord(event.before)?.name)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {event.action === "food.created" ? (
                        <span className="text-muted-foreground">New food</span>
                      ) : changes.length === 0 ? (
                        <span className="text-muted-foreground">No field changes recorded</span>
                      ) : (
                        <ul className="space-y-1">
                          {changes.map((c) => (
                            <li key={c.field} className="tabular-nums">
                              <span className="text-muted-foreground">
                                {c.field.replace(/_/g, " ")}:
                              </span>{" "}
                              <span className="line-through opacity-60">{c.before}</span>{" "}
                              <span aria-hidden>→</span> <span>{c.after}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
