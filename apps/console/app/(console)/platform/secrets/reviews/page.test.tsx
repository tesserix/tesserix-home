import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchProposals = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchProposals: (...args: unknown[]) => fetchProposals(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import type { Proposal } from "@/lib/secrets";
import SecretsReviewsPage, {
  REVIEWS_EMPTY_MESSAGE,
  REVIEWS_UNAVAILABLE_TITLE,
  reviewsReadError,
  reviewsState,
} from "./page";
import { openedAgo, proposalDetailHref, ProposalsTable } from "./proposals-table";

// The page is a server component, exercised the same way `secrets/page.test.tsx`
// exercises its sibling: its default export is awaited and rendered directly,
// and its logic is exercised through the exported pure functions. The client
// table is rendered directly for the row-behaviour tests below.

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  number: 42,
  title: "grant mp-orders a reader on payments/stripe",
  url: "https://github.com/tesserix/tesserix-k8s/pull/42",
  branch: "secrets/grant-mp-orders-payments-stripe",
  author: "octocat",
  createdAt: "2026-08-30T12:00:00Z",
  targets: ["mp-orders"],
  ...over,
});

describe("row rendering", () => {
  it("renders number, title, author and a relative time", () => {
    const rows = [proposal()];
    render(
      <ProposalsTable
        proposals={rows}
        state={reviewsState({ error: null, proposals: rows })}
        emptyMessage={REVIEWS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets/reviews"
      />,
    );
    expect(
      screen.getByText(/#42 grant mp-orders a reader on payments\/stripe/),
    ).toBeInTheDocument();
    expect(screen.getByText("octocat")).toBeInTheDocument();
    // A fixed, far-past createdAt against "now" always renders as a day count
    // — not asserting an exact string keeps this test from rotting the moment
    // it's read on a different day.
    expect(screen.getByText(/\d+d ago|just now|\d+m ago|\d+h ago/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/tesserix/tesserix-k8s/pull/42",
    );
    // Literal path, not `proposalDetailHref({ number: 42 })` — asserting
    // against the function under test would make this pass no matter what
    // path the function actually built, since the render call above reads
    // from the same binding. The `toBe` immediately after cross-checks that
    // this literal and the helper still agree.
    expect(proposalDetailHref({ number: 42 })).toBe("/platform/secrets/reviews/42");
    expect(
      screen.getByRole("link", { name: /#42 grant mp-orders a reader on payments\/stripe/ }),
    ).toHaveAttribute("href", "/platform/secrets/reviews/42");
  });

  // The property Task 7's parser exists to hold reaching this page: Go's
  // zero `time.Time` and an unparseable GitHub timestamp both arrive here as
  // `createdAt: undefined`, and this row must render calmly rather than
  // showing "1 Jan year 1" (what `new Date(undefined)` would produce
  // unguarded) or throwing.
  it("renders without a date when createdAt is absent, rather than a fabricated one or a crash", () => {
    const rows = [proposal({ createdAt: undefined })];
    let container: HTMLElement;
    expect(() => {
      ({ container } = render(
        <ProposalsTable
          proposals={rows}
          state={reviewsState({ error: null, proposals: rows })}
          emptyMessage={REVIEWS_EMPTY_MESSAGE}
          reauthReturnTo="/platform/secrets/reviews"
        />,
      ));
    }).not.toThrow();
    expect(screen.queryByText(/ago/)).toBeNull();
    expect(screen.queryByText(/0001|year 1|Invalid Date/i)).toBeNull();
    // Structural, not just textual: a `<time>` element with no content (which
    // an unguarded `openedAgo(undefined)` would produce, since it falls back
    // to returning its own unparseable input rather than throwing) would pass
    // the two text assertions above while still rendering a dateless `<time>`
    // this cell should not have at all.
    expect(container!.querySelector("time")).toBeNull();
  });

  // The two-tier property `platform.secretsReviews`'s route-id comment
  // exists to hold: reading this queue must never itself require the verb
  // that gates approve/merge/reject, or every operator who can see a
  // proposal could also merge it. Nothing in this row set demands more than
  // `platform`, and the render below proves it by never producing an
  // approve/merge/reject control at all.
  it("renders for a platform-only operator with no approve/merge/reject control on the row", () => {
    const rows = [proposal()];
    render(
      <ProposalsTable
        proposals={rows}
        state={reviewsState({ error: null, proposals: rows })}
        emptyMessage={REVIEWS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets/reviews"
      />,
    );
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });
});

describe("openedAgo", () => {
  it("rounds down and never understates as more recent than 'just now'", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    expect(openedAgo("2026-09-01T00:00:00Z", now)).toBe("just now");
    expect(openedAgo("2026-08-31T23:00:00Z", now)).toBe("1h ago");
    expect(openedAgo("2026-08-30T00:00:00Z", now)).toBe("2d ago");
    // Non-exact durations, specifically to catch a `Math.ceil`/`Math.round`
    // swap that a boundary-only assertion above would miss: 90 seconds must
    // read "1m ago", not "2m ago" — overstating the wait would put a
    // confident wrong number in front of an operator deciding what to
    // triage first.
    expect(openedAgo("2026-08-31T23:58:30Z", now)).toBe("1m ago");
    expect(openedAgo("2026-08-31T22:01:00Z", now)).toBe("1h ago");
  });
});

describe("empty state", () => {
  // Asserted against the literal string, not the imported constant: pinning
  // the assertion to `REVIEWS_EMPTY_MESSAGE` would make this test pass no
  // matter what the constant's value became, since the render call below
  // also reads it from the same binding — the test would then be pinning the
  // code rather than the shipped copy. The `toBe` immediately after cross-
  // checks that this literal and the exported constant still agree.
  it("renders the shipped 'nothing waiting' copy", () => {
    expect(REVIEWS_EMPTY_MESSAGE).toBe("Nothing is waiting for approval.");
    render(
      <ProposalsTable
        proposals={[]}
        state={reviewsState({ error: null, proposals: [] })}
        emptyMessage={REVIEWS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets/reviews"
      />,
    );
    expect(screen.getByText("Nothing is waiting for approval.")).toBeInTheDocument();
  });

  it("renders end-to-end through the page when the read succeeds with no rows", async () => {
    fetchProposals.mockResolvedValue([]);
    render(await SecretsReviewsPage());
    expect(screen.getByText("Nothing is waiting for approval.")).toBeInTheDocument();
  });
});

describe("secrets-api's 503 (no review repository configured)", () => {
  it("resolves to the instrumentation-unavailable state, not an error", () => {
    const state = reviewsState({
      error: new PlatformApiError("no review repository is configured", 503),
      proposals: [],
    });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("renders this surface's own 'not configured' copy, not the kit's observability default", () => {
    const state = reviewsState({
      error: new PlatformApiError("no review repository is configured", 503),
      proposals: [],
    });
    render(
      <ProposalsTable
        proposals={[]}
        state={state}
        emptyMessage={REVIEWS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets/reviews"
      />,
    );
    expect(screen.getByText("The review queue is not configured")).toBeInTheDocument();
    expect(REVIEWS_UNAVAILABLE_TITLE).toBe("The review queue is not configured");
  });

  it("renders the 'not configured' state end-to-end rather than throwing", async () => {
    fetchProposals.mockRejectedValue(new PlatformApiError("no review repository is configured", 503));
    render(await SecretsReviewsPage());
    expect(screen.getByText("The review queue is not configured")).toBeInTheDocument();
    expect(REVIEWS_UNAVAILABLE_TITLE).toBe("The review queue is not configured");
  });

  it("leaves a real failure alone rather than dressing it up as a 503 'not configured' state", () => {
    const surfaced = reviewsReadError(new PlatformApiError("boom", 502));
    expect(surfaced?.unavailable).toBeUndefined();
  });

  it("does not attach this surface's 503 copy to a 501, a different status", () => {
    // `resolveState` itself still maps 501 to `instrumentation-unavailable`
    // (its own default copy, not this surface's) — what this test actually
    // guards is narrower: `reviewsReadError` must not treat 501 as this
    // surface's "no review repository configured" case and must not attach
    // `REVIEWS_UNAVAILABLE_TITLE`/`REVIEWS_UNAVAILABLE_MESSAGE` to it.
    const surfaced = reviewsReadError(new PlatformApiError("boom", 501));
    expect(surfaced?.unavailable).toBeUndefined();
  });
});
