import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoveryPanel } from "./recovery-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ startRecoveryAction: vi.fn() }));

const status = { backups: [{ id: "20260927T055111Z-ae918f84b8d8", created: "2026-09-27T05:51:11Z", bytes: 200000, restoreSeconds: 19.884, openbaoVersion: "2.6.2" }], jobs: [], jobsComplete: true };

describe("recovery controls", () => {
  it("shows retained backups without offering mutations to a read-only operator", () => {
    render(<RecoveryPanel status={status} canRun={false} requestKey="550e8400-e29b-41d4-a716-446655440000" />);
    expect(screen.getByText("20260927T055111Z-ae918f84b8d8")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test restore" })).not.toBeInTheDocument();
  });
  it("offers only backup and isolated restore-test operations", () => {
    const { container } = render(<RecoveryPanel status={status} canRun requestKey="550e8400-e29b-41d4-a716-446655440000" />);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test restore" })).toBeInTheDocument();
    expect([...container.querySelectorAll<HTMLInputElement>('input[name="operation"]')].map((input) => input.value)).toEqual(["backup", "restore-test"]);
  });
});
