import { beforeEach, describe, expect, it, vi } from "vitest";

// Named `page.test.ts`, NOT `page.test.tsx` — vitest.config.ts's `include`
// is `app/**/*.test.ts` (glob-exact, does not match `.test.tsx`), same
// constraint documented throughout ../../ (format.ts, ../page.tsx).
vi.mock("@/lib/api/kora-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/kora-admin")>(
    "@/lib/api/kora-admin",
  );
  return {
    ...actual,
    getKoraUser: vi.fn(),
  };
});

import { KoraAdminError, getKoraUser, type KoraUserDetail } from "@/lib/api/kora-admin";
import KoraUserDetailPageComponent, { countRows, loadErrorMessage } from "./page";
import { canDelete, postDeleteWarning, transferLine } from "./guards";

const mockGetKoraUser = vi.mocked(getKoraUser);

beforeEach(() => {
  mockGetKoraUser.mockReset();
});

function makeUser(overrides: Partial<KoraUserDetail> = {}): KoraUserDetail {
  return {
    id: "u-1",
    email: "a@b.com",
    display_name: "",
    created_at: "2026-01-01T00:00:00Z",
    onboarded_at: null,
    timezone: "",
    has_targets: false,
    log_count: 0,
    first_log: null,
    last_write: null,
    ai_calls: 0,
    counts: {},
    transfers: [],
    has_apple_token: false,
    ...overrides,
  };
}

type PageElement = { type?: unknown; props?: Record<string, unknown> };

function isElement(node: unknown): node is PageElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function findByRole(node: unknown, role: string): PageElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByRole(child, role);
      if (found) return found;
    }
    return undefined;
  }
  if (!isElement(node)) return undefined;
  if (node.props?.role === role) return node;
  return findByRole(node.props?.children, role);
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isElement(node)) return collectText(node.props?.children);
  return "";
}

function renderPage(id = "u-1") {
  return KoraUserDetailPageComponent({ params: Promise.resolve({ id }) });
}

// -----------------------------------------------------------------------
// canDelete — the last gate before an irreversible, no-grace-period delete.
// -----------------------------------------------------------------------
describe("canDelete", () => {
  it("requires the typed email to match exactly before enabling delete", () => {
    expect(canDelete("a@b.com", "a@b.com")).toBe(true);
    // No case-folding on a destructive confirm — mutating canDelete to
    // lower-case both sides before comparing would flip this to true.
    expect(canDelete("a@b.com", "A@B.com")).toBe(false);
    expect(canDelete("a@b.com", "")).toBe(false);
  });

  it("does not trim whitespace before comparing", () => {
    // Mutating canDelete to `typed.trim() === email` would flip this to
    // true; the guard exists so the operator reproduces the address
    // exactly, not "close enough".
    expect(canDelete("a@b.com", " a@b.com ")).toBe(false);
  });

  it("never permits deletion when the user has no email", () => {
    // Guards the `email.length > 0` branch directly: dropping it would let
    // an empty email match an empty typed value (both "" === "").
    expect(canDelete("", "")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// postDeleteWarning — must not tell the operator a delete was complete when
// the Firebase identity survived it.
// -----------------------------------------------------------------------
describe("postDeleteWarning", () => {
  it("warns when the firebase identity survived the delete", () => {
    const warning = postDeleteWarning({
      transfers: [],
      firebase_identity_removed: false,
      apple_token_revoked: true,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("can still sign in");
  });

  it("returns null once the identity is actually gone", () => {
    // Distinct from the negative case above: a constant-null implementation
    // would pass the "survived" test's toBeNull check trivially if it were
    // the only assertion, but it would fail this test's toContain above —
    // and a constant-string implementation would fail this one.
    expect(
      postDeleteWarning({ transfers: [], firebase_identity_removed: true, apple_token_revoked: true }),
    ).toBeNull();
  });
});

describe("transferLine", () => {
  it("names the group, its kind, and the new owner", () => {
    const line = transferLine({ kind: "group", id: "g-1", name: "Runners", new_owner_id: "owner-9" });
    expect(line).toContain("Runners");
    expect(line).toContain("owner-9");
  });
});

describe("countRows", () => {
  it("sorts by table name for a stable render order", () => {
    expect(countRows({ meals: 3, foods: 1 })).toEqual([
      { table: "foods", count: 1 },
      { table: "meals", count: 3 },
    ]);
  });

  it("returns an empty array for an empty counts map", () => {
    expect(countRows({})).toEqual([]);
  });
});

describe("loadErrorMessage", () => {
  it("includes the status, code, and message", () => {
    const msg = loadErrorMessage(500, "boom", "db down");
    expect(msg).toContain("500");
    expect(msg).toContain("boom");
    expect(msg).toContain("db down");
  });
});

describe("KoraUserDetailPage", () => {
  it("renders 'user not found', distinct from a generic load failure, on a 404", async () => {
    mockGetKoraUser.mockRejectedValueOnce(new KoraAdminError(404, "not_found", "no such user"));

    const element = await renderPage("missing");

    const alert = findByRole(element, "alert");
    expect(alert).toBeDefined();
    const text = collectText(alert);
    expect(text).toContain("not found");
    // The 404 branch must NOT fall through to the generic "could not be
    // loaded" copy — pinning its absence here is meaningful because the
    // generic branch is a real, reachable sibling branch in this same
    // component (unlike the vacuous "empty table" check fixed in Task 11,
    // where the alternate branch could never render at all).
    expect(text).not.toContain("could not be loaded");
  });

  it("renders a generic error banner (not the 404 copy, not a blank panel) for a non-404 failure", async () => {
    mockGetKoraUser.mockRejectedValueOnce(new KoraAdminError(500, "server_error", "boom"));

    const element = await renderPage();

    const alert = findByRole(element, "alert");
    expect(alert).toBeDefined();
    const text = collectText(alert);
    expect(text).toContain("could not be loaded");
    expect(text).toContain("500");
    expect(text).toContain("server_error");
    expect(text).toContain("boom");
    expect(text).not.toContain("not found");
  });

  it("shows the per-table counts, the transfer list with the new owner, and the apple-token consequence", async () => {
    mockGetKoraUser.mockResolvedValueOnce(
      makeUser({
        email: "target@example.com",
        counts: { foods: 4, meals: 2 },
        transfers: [{ kind: "group", id: "g-1", name: "Runners", new_owner_id: "jane-id" }],
        has_apple_token: true,
      }),
    );

    const element = await renderPage();

    expect(findByRole(element, "alert")).toBeUndefined();
    const text = collectText(element);
    expect(text).toContain("foods");
    expect(text).toContain("4");
    expect(text).toContain("meals");
    expect(text).toContain("2");
    // Ownership transfer: which group, and to whom — the consequence a count
    // alone does not reveal.
    expect(text).toContain("Runners");
    expect(text).toContain("jane-id");
    // The Apple-token consequence must be stated, not just implied by a
    // boolean somewhere off-screen.
    expect(text).toContain("revoked");
  });

  it("states that no groups transfer when there are none, rather than omitting the section", async () => {
    mockGetKoraUser.mockResolvedValueOnce(makeUser({ transfers: [] }));

    const element = await renderPage();

    const text = collectText(element);
    expect(text).toContain("transfers nothing");
  });

  it("renders the irreversible-no-grace-period warning before the delete control", async () => {
    mockGetKoraUser.mockResolvedValueOnce(makeUser());

    const element = await renderPage();

    const text = collectText(element);
    expect(text).toContain("irreversible");
    expect(text).toContain("no grace period");
  });
});
