// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OperatorMenu } from "./operator-menu";

const PROPS = {
  name: "Mahesh Sangawar",
  email: "mahesh.sangawar@tesserix.app",
  capabilities: ["read", "respond"],
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

  it("shows the email and held capabilities once opened", async () => {
    const user = userEvent.setup();
    render(<OperatorMenu {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /Mahesh Sangawar/ }));
    expect(
      screen.getByText("mahesh.sangawar@tesserix.app"),
    ).toBeInTheDocument();
    expect(screen.getByText("respond")).toBeInTheDocument();
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
    expect(screen.queryByText("respond")).not.toBeInTheDocument();
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
