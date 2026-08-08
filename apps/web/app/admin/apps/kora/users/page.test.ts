import { beforeEach, describe, expect, it, vi } from "vitest";

// Named `page.test.ts`, NOT `page.test.tsx` — vitest.config.ts's `include` is
// `app/**/*.test.ts` (glob-exact, does not match `.test.tsx`), same
// constraint documented in the feedback and food index page.test.ts files.
vi.mock("@/lib/api/kora-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/kora-admin")>(
    "@/lib/api/kora-admin",
  );
  return {
    ...actual,
    listKoraUsers: vi.fn(),
  };
});

import { KoraAdminError, listKoraUsers, type KoraUserList } from "@/lib/api/kora-admin";
import KoraUsersPageComponent, { errorMessageFor, summaryLine } from "./page";

const mockListKoraUsers = vi.mocked(listKoraUsers);

beforeEach(() => {
  mockListKoraUsers.mockReset();
});

function makeList(overrides: Partial<KoraUserList> = {}): KoraUserList {
  return {
    items: [],
    summary: { users: 0, onboarded: 0, ever_logged: 0, tried_never_logged: 0 },
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

describe("summaryLine", () => {
  // The exact production numbers from the task brief: 6 users, 6 onboarded,
  // 2 ever logged, 1 tried but never logged. Pinned to this literal string —
  // this is the funnel line an operator reads at a glance.
  it("renders the summary strip from the API summary, not from the rows", () => {
    expect(summaryLine({ users: 6, onboarded: 6, ever_logged: 2, tried_never_logged: 1 })).toBe(
      "6 users · 6 onboarded (100%) · 2 ever logged (33%) · 1 tried but never logged",
    );
  });

  // Guards the divide-by-zero case explicitly — an empty user table must
  // read "0%", never "NaN%".
  it("does not divide by zero when users is 0", () => {
    expect(summaryLine({ users: 0, onboarded: 0, ever_logged: 0, tried_never_logged: 0 })).toBe(
      "0 users · 0 onboarded (0%) · 0 ever logged (0%) · 0 tried but never logged",
    );
  });
});

describe("errorMessageFor", () => {
  it("shows an explicit error rather than an empty table when the API fails", () => {
    expect(errorMessageFor(500, "boom")).toContain("could not be loaded");
  });
});

describe("KoraUsersPage", () => {
  it("calls listKoraUsers and renders without error when the API succeeds", async () => {
    mockListKoraUsers.mockResolvedValueOnce(
      makeList({
        summary: { users: 6, onboarded: 6, ever_logged: 2, tried_never_logged: 1 },
      }),
    );

    const element = await KoraUsersPageComponent();

    expect(mockListKoraUsers).toHaveBeenCalledTimes(1);
    expect(findByRole(element, "alert")).toBeUndefined();
    expect(collectText(element)).toContain(
      "6 users · 6 onboarded (100%) · 2 ever logged (33%) · 1 tried but never logged",
    );
  });

  it("renders the error alert and NOT an empty table when listKoraUsers throws", async () => {
    mockListKoraUsers.mockRejectedValueOnce(new KoraAdminError(403, "forbidden", "not an admin identity"));

    const element = await KoraUsersPageComponent();

    const alert = findByRole(element, "alert");
    expect(alert).toBeDefined();
    const alertText = collectText(alert);
    expect(alertText).toContain("could not be loaded");
    expect(alertText).toContain("403");
    expect(alertText).toContain("forbidden");
    expect(alertText).toContain("not an admin identity");

    // An error must never render as an empty table — "no users" and "the API
    // is unreachable" are visually distinguishable states.
    expect(collectText(element)).not.toContain("No users yet.");
  });
});
