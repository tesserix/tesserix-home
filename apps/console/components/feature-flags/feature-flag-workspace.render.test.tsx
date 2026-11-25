import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../lib/__fixtures__/feature-flags.json";
import pendingCommands from "../../lib/__fixtures__/feature-flag-commands.json";
import {
  parseFeatureFlagSnapshot,
  featureFlagCommandsSchema,
} from "../../lib/feature-flags-contract";
import { FeatureFlagWorkspace } from "./feature-flag-workspace";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const base = parseFeatureFlagSnapshot(fixture);

describe("Helivanta release controls", () => {
  it("offers readable Staff controls but cannot write with read-only access", () => {
    const change = vi.fn();
    render(
      <FeatureFlagWorkspace
        snapshot={base}
        commands={[]}
        canManage={false}
        operatorSubject="operator-one"
        onChangeAction={change}
      />,
    );
    expect(
      screen.getByRole("switch", {
        name: "Disable Staff accounts and permissions",
      }),
    ).toBeDisabled();
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
  });
  it("pauses every control when a provider outcome is uncertain", () => {
    render(
      <FeatureFlagWorkspace
        snapshot={base}
        commands={featureFlagCommandsSchema.parse(pendingCommands)}
        canManage
        operatorSubject="operator-one"
        onChangeAction={vi.fn()}
      />,
    );
    expect(screen.getByText(/Editing paused/)).toBeInTheDocument();
    for (const control of screen.getAllByRole("switch"))
      expect(control).toBeDisabled();
  });
  it("requires impact review and a reason before submitting the stable request", async () => {
    const change = vi.fn().mockResolvedValue({
      ok: false,
      message: "Refresh and review before trying again.",
    });
    render(
      <FeatureFlagWorkspace
        snapshot={base}
        commands={[]}
        canManage
        operatorSubject="operator-one"
        onChangeAction={change}
      />,
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Disable Staff accounts and permissions",
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Staff records and reviews",
    );
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for this change"), {
      target: { value: "Approved temporary release pause" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    await waitFor(() => expect(change).toHaveBeenCalledOnce());
    expect(change.mock.calls[0]?.[0]).toMatchObject({
      key: "team_accounts",
      enabled: false,
      expected_revision: base.revision,
      reason: "Approved temporary release pause",
    });
    expect(
      screen.getByRole("switch", {
        name: "Disable Staff accounts and permissions",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });
  it("keeps the same intent when the server response is lost", async () => {
    const change = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({ ok: false, message: "Still not confirmed." });
    render(
      <FeatureFlagWorkspace
        snapshot={base}
        commands={[]}
        canManage
        operatorSubject="operator-one"
        onChangeAction={change}
      />,
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Disable Staff accounts and permissions",
      }),
    );
    fireEvent.change(screen.getByLabelText("Reason for this change"), {
      target: { value: "Approved temporary release pause" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    await screen.findByText(/The change could not be confirmed/);
    expect(screen.getByLabelText("Reason for this change")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change.mock.calls[1]?.[0]).toEqual(change.mock.calls[0]?.[0]);
  });
});

it("creates a missing catalogue definition disabled with a reason", async () => {
  const change = vi
    .fn()
    .mockResolvedValue({ ok: true, message: "Created disabled" });
  const snapshot = structuredClone(base);
  snapshot.flags[0] = {
    ...snapshot.flags[0]!,
    provisioned: false,
    enabled: false,
    available: false,
  };
  render(
    <FeatureFlagWorkspace
      snapshot={snapshot}
      commands={[]}
      canManage
      operatorSubject="operator-one"
      onChangeAction={change}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create Staff accounts and permissions",
    }),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("Create disabled flag");
  fireEvent.change(screen.getByLabelText("Reason for this change"), {
    target: { value: "Provision reviewed deployment definition" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm create" }));
  await waitFor(() => expect(change).toHaveBeenCalledOnce());
  expect(change.mock.calls[0]?.[0]).toMatchObject({
    key: "team_accounts",
    enabled: false,
    expected_revision: base.revision,
  });
});

it("labels scoped pilot controls without implying an all-tenant release", () => {
  const pilot = structuredClone(base);
  pilot.flags[0] = { ...pilot.flags[0]!, pilot_only: true };
  render(
    <FeatureFlagWorkspace
      snapshot={pilot}
      commands={[]}
      canManage
      operatorSubject="operator-one"
      onChangeAction={vi.fn()}
    />,
  );
  expect(screen.getByText("Pilot enabled")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("switch", { name: `Disable ${pilot.flags[0]!.title}` }),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Only configured pilot tenants",
  );
  expect(screen.getByRole("dialog")).not.toHaveTextContent(
    "every Helivanta tenant",
  );
  expect(
    screen.getByText(
      /Restricted to configured tenants until the pilot policy expires/,
    ),
  ).toBeInTheDocument();
});
