import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import commands from "../../lib/__fixtures__/feature-flag-commands.json";
import { featureFlagCommandsSchema } from "../../lib/feature-flags-contract";
import { CommandRecovery } from "./command-recovery";

const command = featureFlagCommandsSchema.parse(commands)[0]!;
describe("queued command recovery", () => {
  it("never offers cancellation or resume for uncertain delivery", () => {
    const recover = vi.fn();
    render(
      <CommandRecovery
        command={command}
        requester
        onRecover={recover}
        onResult={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(recover).not.toHaveBeenCalled();
  });
  it("requires confirmation to cancel and does not offer another operator resume", async () => {
    const recover = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        command: {
          ...command,
          state: "failed",
          code: "CANCELED_BEFORE_DISPATCH",
        },
        message: "Canceled",
      });
    render(
      <CommandRecovery
        command={{ ...command, state: "queued" }}
        requester={false}
        onRecover={recover}
        onResult={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Resume request" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued request" }),
    );
    expect(recover).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );
    await waitFor(() =>
      expect(recover).toHaveBeenCalledExactlyOnceWith({
        command: command.id,
        operation: "cancel",
      }),
    );
  });
});
