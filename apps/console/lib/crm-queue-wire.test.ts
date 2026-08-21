import { describe, expect, it } from "vitest";
import { parseQueuePage } from "./crm-queue-wire";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  organisation_id: "22222222-2222-4222-8222-222222222222",
  organisation_name: "Dune",
  product: null,
  stage: "new",
  owner: null,
  next_action_at: "2026-08-21T00:00:00Z",
  next_action_note: "follow up",
  last_contacted_at: null,
  quiet_since: "2026-08-01T00:00:00Z",
  is_starred: false,
};

describe("parseQueuePage", () => {
  it("maps the platform API's snake_case row onto QueueRow", () => {
    const page = parseQueuePage({ opportunities: [row] }, { total: 4, preceding_count: 2 });
    expect(page.rows).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        organisationId: "22222222-2222-4222-8222-222222222222",
        organisationName: "Dune",
        product: null,
        stage: "new",
        owner: null,
        nextActionAt: "2026-08-21T00:00:00Z",
        nextActionNote: "follow up",
        lastContactedAt: null,
        quietSince: "2026-08-01T00:00:00Z",
        isStarred: false,
      },
    ]);
    expect(page.total).toBe(4);
    expect(page.precedingCount).toBe(2);
  });

  it("defaults cursors to null when meta omits them", () => {
    const page = parseQueuePage({ opportunities: [] }, { total: 0, preceding_count: 0 });
    expect(page.nextCursor).toBeNull();
    expect(page.previousCursor).toBeNull();
    expect(page.rows).toEqual([]);
  });

  it("carries cursors through when meta has them", () => {
    const page = parseQueuePage({ opportunities: [] },
      { total: 0, preceding_count: 0, next_cursor: "abc", previous_cursor: "xyz" });
    expect(page.nextCursor).toBe("abc");
    expect(page.previousCursor).toBe("xyz");
  });

  it("refuses a payload whose opportunities are not an array", () => {
    expect(() => parseQueuePage({ opportunities: {} }, {})).toThrow(/opportunities/);
  });

  it("refuses a row missing a required field rather than yielding undefined", () => {
    const { quiet_since: _dropped, ...missing } = row;
    expect(() => parseQueuePage({ opportunities: [missing] }, {})).toThrow(/quiet_since/);
  });
});
