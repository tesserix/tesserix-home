import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const approveAndMergeAction = vi.fn();
const rejectProposalAction = vi.fn();

vi.mock("./actions", () => ({
  approveAndMergeAction: (...args: unknown[]) => approveAndMergeAction(...args),
  rejectProposalAction: (...args: unknown[]) => rejectProposalAction(...args),
}));

import type { ProposalDetail } from "@/lib/secrets";
import { CANNOT_APPROVE_MESSAGE, ProposalView } from "./proposal-view";

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
  files: [
    {
      filename: "apps/mp-orders/whitelist.yaml",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
    },
  ],
};

beforeEach(() => {
  approveAndMergeAction.mockReset();
  rejectProposalAction.mockReset();
});

describe("the diff", () => {
  it("renders the patch as text inside its own horizontally-scrolling container", () => {
    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("@@ -0,0 +1,3 @@\n+a\n+b\n+c");
    // The scrolling container is the `pre`'s own parent, not the page body —
    // `page-body` never carries `overflow-x-auto` in this app, so finding it
    // on an ancestor closer than the body is what proves the diff scrolls in
    // its own box.
    const scroller = pre!.parentElement;
    expect(scroller?.className).toContain("overflow-x-auto");
  });

  it("renders markup-shaped patch content as literal text, never as an element", () => {
    const proposal: ProposalDetail = {
      ...PROPOSAL,
      files: [
        {
          filename: "evil.yaml",
          additions: 1,
          deletions: 0,
          patch: '+<img src=x onerror="alert(1)"><script>alert(2)</script>',
        },
      ],
    };

    render(
      <ProposalView
        number={42}
        proposal={proposal}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    // The literal string is present as text...
    expect(document.querySelector("pre")!.textContent).toContain(
      '+<img src=x onerror="alert(1)"><script>alert(2)</script>',
    );
    // ...and was never parsed into real elements.
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders a long, non-ASCII patch without throwing, still inside the scrolling container", () => {
    const longLine = "é🙂中文".repeat(500);
    const proposal: ProposalDetail = {
      ...PROPOSAL,
      files: [{ filename: "wide.yaml", additions: 1, deletions: 0, patch: `+${longLine}` }],
    };

    expect(() => {
      render(
        <ProposalView
          number={42}
          proposal={proposal}
          state={{ kind: "ready" }}
          canAct
          operatorLabel="ava@tesserix.app"
        />,
      );
    }).not.toThrow();

    const pre = document.querySelector("pre");
    expect(pre!.textContent).toBe(`+${longLine}`);
    expect(pre!.parentElement?.className).toContain("overflow-x-auto");
  });
});

describe("the act-affordance", () => {
  it("shows Approve & merge (primary) then Reject (secondary) to an operator who can act", () => {
    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Approve & merge", "Reject"]);
    expect(screen.queryByText(CANNOT_APPROVE_MESSAGE)).toBeNull();
  });

  // Both absences asserted, not just the sentence — a test checking only the
  // sentence would still pass with the buttons rendered right beside it.
  it("shows the refusal sentence and no controls at all when the operator cannot act", () => {
    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct={false}
        operatorLabel="ava@tesserix.app"
      />,
    );

    expect(screen.getByText(CANNOT_APPROVE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});

describe("approving and merging", () => {
  it("calls approveAndMergeAction with the proposal number, and shows 'Approved by' on success", async () => {
    approveAndMergeAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve & merge" }));

    await waitFor(() => expect(screen.getByText("Approved by ava@tesserix.app")).toBeInTheDocument());
    expect(approveAndMergeAction).toHaveBeenCalledWith(42);
    // No control is offered on a merged proposal.
    expect(screen.queryByRole("button", { name: "Approve & merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("shows the failure message and keeps the controls when the action fails", async () => {
    approveAndMergeAction.mockResolvedValue({
      ok: false,
      message: "The approval went through, but the merge did not: The merge did not go through.",
    });
    const user = userEvent.setup();

    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve & merge" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "The approval went through, but the merge did not: The merge did not go through.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Approve & merge" })).toBeInTheDocument();
  });
});

describe("rejecting", () => {
  it("calls rejectProposalAction with the proposal number, and shows 'Rejected by ... nothing changed' on success", async () => {
    rejectProposalAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(screen.getByText("Rejected by ava@tesserix.app — nothing changed")).toBeInTheDocument(),
    );
    expect(rejectProposalAction).toHaveBeenCalledWith(42);
    expect(screen.queryByRole("button", { name: "Approve & merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("shows the failure message and keeps the controls when the rejection fails", async () => {
    rejectProposalAction.mockResolvedValue({ ok: false, message: "The rejection was not recorded." });
    const user = userEvent.setup();

    render(
      <ProposalView
        number={42}
        proposal={PROPOSAL}
        state={{ kind: "ready" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(screen.getByText("The rejection was not recorded.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});

describe("non-ready states", () => {
  it("renders the surface-state view, not the diff, when the state is not ready", () => {
    render(
      <ProposalView
        number={42}
        proposal={null}
        state={{ kind: "error", message: "boom" }}
        canAct
        operatorLabel="ava@tesserix.app"
      />,
    );

    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
  });
});
