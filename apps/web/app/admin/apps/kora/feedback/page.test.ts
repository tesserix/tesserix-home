import { beforeEach, describe, expect, it, vi } from "vitest";

// Named `page.test.ts`, NOT `page.test.tsx` — vitest.config.ts's `include` is
// `app/**/*.test.ts` (glob-exact, does not match `.test.tsx`), a constraint
// already documented in the food index's page.test.ts. No JSX syntax is
// needed here (the page's returned element tree is walked as plain objects).
vi.mock("@/lib/api/kora-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/kora-admin")>(
    "@/lib/api/kora-admin",
  );
  return {
    ...actual,
    listKoraFeedback: vi.fn(),
  };
});

import { KoraAdminError, listKoraFeedback, type KoraFeedbackPage } from "@/lib/api/kora-admin";
import KoraFeedbackPageComponent, { buildHref } from "./page";

const mockListKoraFeedback = vi.mocked(listKoraFeedback);

beforeEach(() => {
  mockListKoraFeedback.mockReset();
});

function makePage(overrides: Partial<KoraFeedbackPage> = {}): KoraFeedbackPage {
  return { items: [], total: 0, ...overrides };
}

function renderPage(searchParams: Record<string, string> = {}) {
  return KoraFeedbackPageComponent({ searchParams: Promise.resolve(searchParams) });
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

describe("buildHref", () => {
  // The pager has to carry `status` and `kind` through an offset change — a
  // pager that drops the active filters silently widens the list under the
  // operator, who has no reason to suspect it.
  it("preserves status and kind while changing offset", () => {
    const href = buildHref({ status: "in_progress", kind: "bug", offset: 50 });
    expect(href).toContain("status=in_progress");
    expect(href).toContain("kind=bug");
    expect(href).toContain("offset=50");
  });

  it("omits offset=0 (the first page has no offset param)", () => {
    const href = buildHref({ status: "open", kind: "", offset: 0 });
    expect(href).toContain("status=open");
    expect(href).not.toContain("offset=");
  });

  it("omits status and kind entirely when both are empty (the All filters)", () => {
    const href = buildHref({ status: "", kind: "", offset: 0 });
    expect(href).toBe("/admin/apps/kora/feedback");
  });
});

describe("KoraFeedbackPage default status filter", () => {
  // The operator's question on opening this page is "what needs my
  // attention" — an absent `status` param must default to "open".
  it("defaults to status=open when the param is absent", async () => {
    mockListKoraFeedback.mockResolvedValueOnce(makePage());

    await renderPage({});

    expect(mockListKoraFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" }),
    );
  });

  // The "All" filter sets status="" explicitly. Asserting only the case
  // above would also pass against an implementation that ignores the param
  // entirely and always sends "open" — this half is what actually pins the
  // escape hatch.
  it("respects an explicit empty status instead of re-defaulting to open", async () => {
    mockListKoraFeedback.mockResolvedValueOnce(makePage());

    await renderPage({ status: "" });

    expect(mockListKoraFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });
});

describe("KoraFeedbackPage error state", () => {
  it("renders the error alert and NOT the empty state when listKoraFeedback throws", async () => {
    mockListKoraFeedback.mockRejectedValueOnce(
      new KoraAdminError(403, "forbidden", "not an admin identity"),
    );

    const element = await renderPage({});

    const alert = findByRole(element, "alert");
    expect(alert).toBeDefined();
    const alertText = collectText(alert);
    expect(alertText).toContain("403");
    expect(alertText).toContain("forbidden");
    expect(alertText).toContain("not an admin identity");

    expect(collectText(element)).not.toContain("No feedback matches this filter.");
  });
});
