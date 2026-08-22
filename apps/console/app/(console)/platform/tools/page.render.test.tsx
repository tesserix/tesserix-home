import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tools-directory", () => ({ readToolsDirectory: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
  hasCapability: vi.fn(),
}));
vi.mock("@/lib/internal-access", () => ({ requiresCapability: vi.fn() }));

import { readToolsDirectory } from "@/lib/tools-directory";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";
import ToolsPage from "./page";

const DIRECTORY = {
  source: "platform-api" as const,
  groups: [{ key: "identity", label: "Identity and secrets", sortOrder: 1 }],
  tools: [
    {
      id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.",
      note: null, groupKey: "identity", sortOrder: 1,
    },
  ],
};

afterEach(() => vi.resetAllMocks());

function allow() {
  vi.mocked(requiresCapability).mockReturnValue(true);
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1", email: "op@t.test", roles: ["platform"],
  } as never);
  vi.mocked(hasCapability).mockReturnValue(true);
}

describe("the tools management page", () => {
  it("renders the directory for an operator holding platform", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue(DIRECTORY);

    render(await ToolsPage());

    expect(screen.getByText("Zitadel")).toBeInTheDocument();
    expect(screen.getByText("Identity and secrets")).toBeInTheDocument();
  });

  it("refuses an operator without platform, and shows no directory", async () => {
    vi.mocked(requiresCapability).mockReturnValue(true);
    vi.mocked(getCurrentSession).mockResolvedValue({
      sub: "op-2", email: "op2@t.test", roles: ["crm"],
    } as never);
    vi.mocked(hasCapability).mockReturnValue(false);
    vi.mocked(readToolsDirectory).mockResolvedValue(DIRECTORY);

    render(await ToolsPage());

    // Not merely "controls hidden" — the surface itself is refused. Rendering
    // the directory here leaks nothing, but it tells an operator this page is
    // theirs when none of it works.
    expect(screen.queryByText("Zitadel")).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
  });

  it("explains itself when the platform API is switched off", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue({ ...DIRECTORY, source: "builtin" });

    render(await ToolsPage());

    expect(screen.getByText(/switched off/i)).toBeInTheDocument();
    expect(screen.queryByText("Zitadel")).not.toBeInTheDocument();
  });

  it("distinguishes an unreachable API from a switched-off one", async () => {
    allow();
    vi.mocked(readToolsDirectory).mockResolvedValue({ ...DIRECTORY, source: "degraded" });

    render(await ToolsPage());

    // Two different problems with two different remedies. Collapsing them is
    // the defect three-valued `source` was introduced to fix.
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
    expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
  });
});
