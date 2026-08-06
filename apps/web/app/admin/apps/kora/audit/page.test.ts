import { beforeEach, describe, expect, it, vi } from "vitest";

// Named `page.test.ts`, NOT `.test.tsx` — vitest.config.ts's `include` is
// `app/**/*.test.ts` (glob-exact), so a `.test.tsx` here is silently never
// collected. Same note as app/admin/apps/kora/foods/page.test.ts.
vi.mock("@/lib/api/kora-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/kora-admin")>(
    "@/lib/api/kora-admin",
  );
  return { ...actual, listKoraEvents: vi.fn() };
});

import { KoraAdminError, listKoraEvents, type KoraAdminEvent } from "@/lib/api/kora-admin";
import KoraAuditPage from "./page";
import { diffEvent } from "./event-table";

const mockListKoraEvents = vi.mocked(listKoraEvents);

// Block body, not an expression arrow: `mockReset()` returns the mock, and
// vitest treats a value returned from `beforeEach` as a teardown callback.
beforeEach(() => {
  mockListKoraEvents.mockReset();
});

type El = { type?: unknown; props?: Record<string, unknown> };

/**
 * Flattens the returned element tree into plain text for assertions.
 *
 * Sync function components are INVOKED rather than skipped. Without this, an
 * element like `<EventTable events={…} />` contributes nothing: its content is
 * behind its own function, not in `props.children`, so every assertion about
 * the table's text would silently pass against an empty string — the test
 * equivalent of the bug this page exists to prevent. Anything that throws when
 * invoked (a client component, one using hooks) falls back to walking its
 * children, so this stays safe for trees it cannot render.
 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as El;
  if (typeof el.type === "function") {
    try {
      const rendered = (el.type as (props: unknown) => unknown)(el.props ?? {});
      return textOf(rendered);
    } catch {
      // Not renderable in isolation — fall through to its children.
    }
  }
  return textOf(el.props?.children);
}

/** Collects every element carrying the given prop value (e.g. role="alert"). */
function findByProp(node: unknown, prop: string, value: unknown): El[] {
  const found: El[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const el = n as El;
    if (el.props?.[prop] === value) found.push(el);
    if (typeof el.type === "function") {
      try {
        return walk((el.type as (props: unknown) => unknown)(el.props ?? {}));
      } catch {
        // Fall through to children.
      }
    }
    walk(el.props?.children);
  };
  walk(node);
  return found;
}

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

async function render(searchParams: Record<string, string> = {}) {
  return KoraAuditPage({ searchParams: Promise.resolve(searchParams) });
}

describe("Kora audit page", () => {
  it("renders who did what, and when", async () => {
    mockListKoraEvents.mockResolvedValue({ items: [event()], total: 1 });

    const text = textOf(await render());

    expect(text).toContain("admin@tesserix.app");
    expect(text).toContain("Edited");
    expect(text).toContain("Rolled oats");
  });

  // THE central property of this page, and the reason it has a test at all: an
  // audit page that renders a failed fetch as an empty table is asserting "no
  // admin has ever changed anything" — a false statement about the integrity
  // record itself.
  it("renders an upstream failure as an error, never as an empty trail", async () => {
    mockListKoraEvents.mockRejectedValue(new KoraAdminError(502, "upstream_unreachable"));

    const tree = await render();
    const text = textOf(tree);

    expect(findByProp(tree, "role", "alert")).toHaveLength(1);
    expect(text).toContain("could not be loaded");
    expect(text).not.toContain("No admin changes have been recorded yet");
  });

  // The twin: a genuinely empty trail is a legitimate empty state, not an
  // error. Without this, the test above would pass against a page that
  // rendered EVERYTHING as an error.
  it("renders a genuinely empty trail as an empty state", async () => {
    mockListKoraEvents.mockResolvedValue({ items: [], total: 0 });

    const tree = await render();

    expect(findByProp(tree, "role", "alert")).toHaveLength(0);
    expect(textOf(tree)).toContain("No admin changes have been recorded yet");
  });

  it("passes target_id through as a filter and offers a way to clear it", async () => {
    mockListKoraEvents.mockResolvedValue({ items: [], total: 0 });
    const target = "3bd526ec-ab82-42fb-bf47-083fa0c4cde5";

    const text = textOf(await render({ target_id: target }));

    expect(mockListKoraEvents).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: target }),
    );
    expect(text).toContain("Show every change");
  });

  // Next hands back `string | string[]` for a repeated query key. Taking it
  // unnarrowed stringifies ["a","b"] to "a,b" via Array#toString, which would
  // be sent upstream as a bogus target_id.
  it("takes the first value of a repeated query parameter", async () => {
    mockListKoraEvents.mockResolvedValue({ items: [], total: 0 });
    const first = "3bd526ec-ab82-42fb-bf47-083fa0c4cde5";

    await KoraAuditPage({
      searchParams: Promise.resolve({ target_id: [first, "second"], offset: ["10", "20"] }),
    } as never);

    expect(mockListKoraEvents).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: first, offset: 10 }),
    );
  });

  // A hand-edited or stale URL can carry an offset past the end. Rendering the
  // ordinary empty state there would claim the trail is empty when it is not —
  // the same false fact the food index guards against.
  it("distinguishes a past-the-end page from an empty trail", async () => {
    mockListKoraEvents.mockResolvedValue({ items: [], total: 120 });

    const text = textOf(await render({ offset: "5000" }));

    expect(text).toContain("past the end");
    expect(text).not.toContain("No admin changes have been recorded yet");
  });
});

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
