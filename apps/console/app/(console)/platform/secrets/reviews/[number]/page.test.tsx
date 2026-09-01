import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchProposal = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchProposal: (...args: unknown[]) => fetchProposal(...args),
}));

// `getCurrentSession` and `requiresCapability` back the act-affordance gate
// below. `hasCapability` itself is NOT mocked, matching `secrets/[...path]/
// page.test.tsx` — a passing gate test here is evidence about the real
// capability decision, not a stand-in for it.
const getCurrentSession = vi.fn();
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: (...args: unknown[]) => getCurrentSession(...args),
}));

const requiresCapability = vi.fn((..._args: unknown[]) => true);
vi.mock("@/lib/internal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/internal-access")>()),
  requiresCapability: (...args: unknown[]) => requiresCapability(...args),
}));

// The proposal-view.tsx below calls server actions on click — none of the
// tests here click a control, so the module is left real; it is exercised
// directly in `proposal-view.test.tsx`.

import { PlatformApiError } from "@/lib/platform-api-error";
import type { ProposalDetail } from "@/lib/secrets";
import ProposalDetailPage from "./page";
import { CANNOT_APPROVE_MESSAGE } from "./proposal-view";

// The page is a server component, exercised the same way every other detail
// route in this app is: its default export is awaited and rendered directly,
// and `notFound()` — real, not mocked — is asserted on by its thrown digest.

function renderPage(rawNumber: string) {
  return ProposalDetailPage({ params: Promise.resolve({ number: rawNumber }) });
}

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404"),
  });
}

const PROPOSAL: ProposalDetail = {
  number: 42,
  title: "grant mp-orders a reader on payments/stripe",
  url: "https://github.com/tesserix/tesserix-k8s/pull/42",
  branch: "secrets/grant-mp-orders-payments-stripe",
  author: "octocat",
  createdAt: "2026-08-30T12:00:00Z",
  targets: ["mp-orders"],
  mergeableState: "clean",
  approvals: [],
  files: [{ filename: "apps/mp-orders/whitelist.yaml", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" }],
};

beforeEach(() => {
  fetchProposal.mockReset();
  getCurrentSession.mockReset();
  getCurrentSession.mockResolvedValue(null);
  requiresCapability.mockReset();
  requiresCapability.mockReturnValue(true);
});

describe("proposal number validation", () => {
  it("renders not-found for a non-numeric segment, never calling fetchProposal", async () => {
    await expectNotFound(renderPage("not-a-number"));
    expect(fetchProposal).not.toHaveBeenCalled();
  });

  it("renders not-found for zero, never calling fetchProposal", async () => {
    await expectNotFound(renderPage("0"));
    expect(fetchProposal).not.toHaveBeenCalled();
  });

  it("renders not-found for a negative number, never calling fetchProposal", async () => {
    await expectNotFound(renderPage("-3"));
    expect(fetchProposal).not.toHaveBeenCalled();
  });

  it("fetches with the parsed number for a valid segment", async () => {
    fetchProposal.mockResolvedValue(PROPOSAL);

    render(await renderPage("42"));

    expect(fetchProposal).toHaveBeenCalledWith(42);
  });
});

describe("the proposal detail surface", () => {
  // No test asserting a 404-to-notFound() mapping here: `GET
  // /api/reviews/:number` never returns 404 (see `page.tsx`'s comment on
  // this branch), so such a test would pin behaviour that cannot occur.

  // This route inherits its 503 handling from `reviewsState` (imported from
  // `../page`) rather than implementing its own — see the import's doc
  // comment. Nothing here re-verifies that reuse still produces the "not
  // configured" surface state, so a future change that stops sharing
  // `reviewsState` (or changes its 503 branch) would go uncaught without
  // this test.
  it("renders the 'not configured' state on the reviewer's 503, matching the queue page", async () => {
    fetchProposal.mockRejectedValue(new PlatformApiError("no review repository is configured", 503));

    render(await renderPage("42"));

    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  it("renders the proposal's title and diff on success", async () => {
    fetchProposal.mockResolvedValue(PROPOSAL);

    render(await renderPage("42"));

    expect(
      screen.getByRole("heading", { name: /#42 grant mp-orders a reader on payments\/stripe/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("apps/mp-orders/whitelist.yaml", { exact: false })).toBeInTheDocument();
  });
});

describe("the act-affordance gate", () => {
  // Approving/merging/rejecting requires BOTH `platform` and
  // `rotate-credentials` — `secrets-api` enforces that itself on its `live`
  // route group, so this gate is never the thing stopping a write. It only
  // decides whether an operator sees a control that would 403 if clicked.
  beforeEach(() => {
    fetchProposal.mockResolvedValue(PROPOSAL);
  });

  function signIn(roles: readonly string[]) {
    getCurrentSession.mockResolvedValue({
      sub: "operator-1",
      email: "ava@tesserix.app",
      roles,
      iat: 0,
      exp: 0,
    });
  }

  it("shows Approve & merge and Reject to an operator holding platform and rotate-credentials", async () => {
    signIn(["platform", "rotate-credentials"]);

    render(await renderPage("42"));

    expect(screen.getByRole("button", { name: "Approve & merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByText(CANNOT_APPROVE_MESSAGE)).toBeNull();
  });

  // Both absences are asserted, not just the refusal sentence — a test
  // checking only the sentence would still pass if the buttons rendered
  // right alongside it.
  it("shows the refusal sentence, and NEITHER control, to a platform-only operator", async () => {
    signIn(["platform"]);

    render(await renderPage("42"));

    expect(screen.getByText(CANNOT_APPROVE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("shows the controls under the pre-cutover bypass, same as any other render-path gate", async () => {
    requiresCapability.mockReturnValue(false);
    signIn([]);

    render(await renderPage("42"));

    expect(screen.getByRole("button", { name: "Approve & merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});
