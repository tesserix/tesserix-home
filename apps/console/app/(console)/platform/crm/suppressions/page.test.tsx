import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SuppressionRow } from "@/lib/db/crm-repo";

const listSuppressions = vi.fn();

vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  listSuppressions: (...args: unknown[]) => listSuppressions(...args),
}));

// `suppressions-view.tsx`'s add form and per-row "Remove" call `useRouter()`
// to refresh after a server action — same reason `crm/page.test.tsx` mocks
// this for `CrmQueueView`.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import CrmSuppressionsPage, { suppressionsState, EMPTY_MESSAGE } from "./page";

const ROW: SuppressionRow = {
  id: "s1",
  email: "ava@example.com",
  instagramHandle: null,
  reason: "unsubscribed",
  createdBy: "ava@tesserix.app",
  createdAt: "2026-08-16T00:00:00.000Z",
};

beforeEach(() => {
  listSuppressions.mockReset();
});

async function renderPage() {
  render(await CrmSuppressionsPage());
}

describe("suppressionsState", () => {
  it("reports empty — not ready — when there is nothing on the list", () => {
    expect(suppressionsState({ error: null, rows: [] })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is at least one row", () => {
    expect(suppressionsState({ error: null, rows: [ROW] })).toEqual({ kind: "ready" });
  });

  it("prefers the error over an empty list", () => {
    // A failed read also has no rows; "nobody is on the list" would tell an
    // operator the list is genuinely empty when the read simply failed —
    // exactly the distinction `[organisation]/page.tsx`'s `detailState` makes
    // for a missing organisation vs. a failed lookup.
    expect(suppressionsState({ error: new Error("boom"), rows: [] }).kind).toBe("error");
  });
});

describe("EMPTY_MESSAGE", () => {
  it("is the copy the page actually ships, exported so a test can assert on it rather than a second copy of it", () => {
    expect(EMPTY_MESSAGE).toBe("Nobody is on the do-not-contact list.");
  });
});

// The wiring the pure-function tests above cannot exercise: CrmSuppressionsPage's
// own try/catch around `listSuppressions()`, which is what actually decides
// whether a failed read renders as "nobody is on the list" (wrong — the read
// never even completed) or as an error an operator can see and retry.
describe("CrmSuppressionsPage", () => {
  it("renders the empty state, not the do-not-contact list's rows, when nothing is suppressed", async () => {
    listSuppressions.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByText(EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("renders every suppression's key once the list has rows", async () => {
    listSuppressions.mockResolvedValue([ROW]);

    await renderPage();

    expect(screen.getByText("ava@example.com")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  // The exact failure a thin, non-rendering test would miss: a failed read
  // and an empty list produce the same `rows: []`, and only the page's own
  // try/catch is what tells them apart. Rendering "nobody is on the list"
  // for a database outage on a do-not-contact list is a dangerous silent
  // failure — an operator would believe the suppression they're checking
  // for doesn't exist, when the read simply never ran.
  it("renders an error, not the empty-list message, when the read fails", async () => {
    listSuppressions.mockRejectedValue(new Error("connection terminated"));

    await renderPage();

    // The error state, not the empty state — but NOT the raw pg message.
    // `relation "crm_suppressions" does not exist` in front of an operator
    // is the read-path version of the constraint-name leak `lib/crm-write.ts`
    // records on the write path.
    expect(screen.queryByText("connection terminated")).toBeNull();
    expect(screen.getByText(/could not load the do-not-contact list/i)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });
});
