// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OperatorMenu } from "./operator-menu";

const PROPS = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  // One surface (`crm`) and two actions (`respond`, `hard-delete`), plus the
  // entry ticket — so the counts below are distinguishable from each other and
  // from the total. Equal counts would pass a component that reported the
  // wrong one.
  capabilities: ["read", "crm", "respond", "hard-delete"],
  showCapabilities: true,
};

describe("OperatorMenu", () => {
  it("names the signed-in operator on the trigger", async () => {
    render(<OperatorMenu {...PROPS} />);
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });

  it("falls back to the email when no name is on the session", () => {
    render(<OperatorMenu {...PROPS} name="" />);
    expect(
      screen.getByRole("button", { name: /mahesh\.sangawar@tesserix\.app/ }),
    ).toBeInTheDocument();
  });

  it("shows the email and a count of what is held, once opened", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));

    expect(
      screen.getByText("mahesh.sangawar@tesserix.app"),
    ).toBeInTheDocument();
    // `read` is the entry ticket and is deliberately not counted: it grants no
    // surface, so including it would report one the operator does not have.
    expect(screen.getByText("1 surface · 2 actions")).toBeInTheDocument();
  });

  it("does not list the capabilities themselves", async () => {
    // The menu used to render all twelve as raw slugs, alphabetically, with
    // surfaces and verbs interleaved. The list belongs on the profile page,
    // where it can be grouped and read from the LIVE store rather than from
    // this cookie.
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));

    expect(screen.queryByText("hard-delete")).not.toBeInTheDocument();
  });

  it("links to the profile page for the detail", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));

    expect(screen.getByRole("link", { name: /view your access/i })).toHaveAttribute(
      "href",
      "/platform/profile",
    );
  });

  it("uses the singular when exactly one of a kind is held", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} capabilities={["read", "crm", "respond"]} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));

    expect(screen.getByText("1 surface · 1 action")).toBeInTheDocument();
  });

  it("offers sign out as a link to the logout route", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.getByRole("link", { name: /sign out/i })).toHaveAttribute(
      "href",
      "/auth/logout",
    );
  });

  it("says so rather than showing an empty list when capabilities are unknown", async () => {
    // Under the legacy provider a session carries no roles at all. An empty
    // list would read as "you hold nothing", which is a different claim.
    const user = userEvent.setup();
    render(
      <OperatorMenu {...PROPS} capabilities={[]} showCapabilities={false} />,
    );
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.queryByText(/surface/)).not.toBeInTheDocument();
    expect(screen.getByText(/not recorded on this session/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(screen.getByRole("link", { name: /sign out/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: /sign out/i })).not.toBeInTheDocument();
  });
});

describe("OperatorMenu avatar", () => {
  it("shows initials derived from the name", async () => {
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(screen.getByText("MS")).toBeInTheDocument();
  });

  it("falls back to the email's first letter when there is no name", () => {
    render(<OperatorMenu {...PROPS} name="" email="asha@example.com" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("hides the initials from screen readers, since the name is already there", () => {
    // The trigger's accessible name already carries the identity; announcing
    // "MS" as well would read the operator's identity out twice.
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(screen.getByText("MS")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the name visible beside the avatar", () => {
    render(<OperatorMenu {...PROPS} name="Mahesh Sangawar" />);
    expect(
      screen.getByRole("button", { name: /Mahesh Sangawar/ }),
    ).toBeInTheDocument();
  });
});
