import { describe, expect, it } from "vitest";

import { diffEvent } from "./event-table";
import type { KoraAdminEvent } from "@/lib/api/kora-admin";

/**
 * `event-table.test.ts`, and this directory has no `page.tsx` any more.
 *
 * #139 retired `/admin/apps/kora/audit` into the console's estate-wide audit
 * timeline, so the page and its tests are gone. `event-table.tsx` is NOT gone:
 * `app/admin/apps/kora/foods/[id]/page.tsx` renders it for the "what happened
 * to THIS food" view, which is a different surface and is not being retired.
 * A directory with no `page.tsx` declares no route, so what remains here is a
 * plain colocated component — kept at this path rather than moved under
 * `components/` because vitest.config.ts's `include` is `lib/**` and `app/**`
 * only, and a test moved to `components/` would be silently never collected.
 *
 * Named `.test.ts`, NOT `.test.tsx`, for the same reason: the glob is exact.
 */

function event(overrides: Partial<KoraAdminEvent> = {}): KoraAdminEvent {
  return {
    id: "e1",
    actor_id: "admin-uid-1",
    actor_email: "admin@tesserix.app",
    action: "food.updated",
    target_type: "food_item",
    target_id: "3bd526ec-ab82-42fb-bf47-083fa0c4cde5",
    before: { name: "Oats", kcal_per_100g: 380 },
    after: { name: "Rolled oats", kcal_per_100g: 389 },
    created_at: "2026-08-06T01:00:00Z",
    ...overrides,
  };
}

describe("diffEvent", () => {
  it("reports only the fields that actually changed", () => {
    const changes = diffEvent(event());
    expect(changes.map((c) => c.field)).toEqual(["name", "kcal_per_100g"]);
    expect(changes[0]).toMatchObject({ before: "Oats", after: "Rolled oats" });
  });

  // Derived fields follow the ones an operator actually edited —
  // normalized_name tracks name, has_embedding is cleared BY a rename — so
  // including them would report one edit as three changes and bury the real one.
  it("ignores derived fields", () => {
    const changes = diffEvent(
      event({
        before: { name: "Oats", normalized_name: "oats", has_embedding: true },
        after: { name: "Rolled oats", normalized_name: "rolled oats", has_embedding: false },
      }),
    );
    expect(changes.map((c) => c.field)).toEqual(["name"]);
  });

  // A create has no `before`, and a row from a future action type may have
  // neither snapshot. A crash here would take down the page whose only job is
  // to show what happened.
  it("survives a missing before or after", () => {
    expect(() => diffEvent(event({ before: undefined }))).not.toThrow();
    expect(diffEvent(event({ before: undefined, after: undefined }))).toEqual([]);
    expect(diffEvent(event({ before: null, after: "not-an-object" }))).toEqual([]);
  });

  // A retirement's visible change IS deleted_at going from absent to a
  // timestamp. Dropping it would render the single most consequential action
  // in the trail as "no field changes recorded".
  it("reports a retirement as a deleted_at change", () => {
    const changes = diffEvent(
      event({
        action: "food.deleted",
        before: { name: "Oats" },
        after: { name: "Oats", deleted_at: "2026-08-06T01:00:00Z" },
      }),
    );
    expect(changes.map((c) => c.field)).toEqual(["deleted_at"]);
    expect(changes[0]).toMatchObject({ before: "—", after: "2026-08-06T01:00:00Z" });
  });
});
