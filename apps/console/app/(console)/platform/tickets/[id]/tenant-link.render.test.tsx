// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/console-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/console-core")>()),
  isPending: vi.fn(),
}));

import { isPending } from "@tesserix/console-core";
import { TenantLink } from "./tenant-link";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TenantLink", () => {
  it("renders the tenant inert while its rail is pending", () => {
    vi.mocked(isPending).mockReturnValue(true);
    render(<TenantLink productId="mark8ly" tenantId="tenant-7" />);

    // Guards the guard. A test that only asserted "no link" would pass if the
    // component rendered nothing at all — which would be a different bug
    // (losing the tenant id from the rail), not the behaviour being asserted.
    // So: the tenant is still shown, and it is still not navigable.
    expect(screen.getByTestId("tenant-link")).toBeInTheDocument();
    expect(screen.getByText("tenant-7")).toBeInTheDocument();

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("tenant-link").tagName).not.toBe("A");
    expect(screen.getByTestId("tenant-link")).not.toHaveAttribute("href");
  });

  it("never falls back to an apps/web href for a pending rail", () => {
    // The failure this rules out is not "no link" but "link into the admin we
    // are retiring" — see RouteEntry.pending in console-core's routes.ts.
    vi.mocked(isPending).mockReturnValue(true);
    const { container } = render(
      <TenantLink productId="mark8ly" tenantId="tenant-7" />,
    );
    expect(container.innerHTML).not.toContain("/admin/");
  });

  it("links through the console route table once the rail is built", () => {
    vi.mocked(isPending).mockReturnValue(false);
    render(<TenantLink productId="mark8ly" tenantId="tenant-7" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "/platform/apps/mark8ly/tenants/tenant-7",
    );
    expect(link.getAttribute("href")).not.toMatch(/^\/admin\//);
  });

  it("resolves the rail through isPending rather than assuming it", () => {
    vi.mocked(isPending).mockReturnValue(true);
    render(<TenantLink productId="mark8ly" tenantId="tenant-7" />);
    expect(isPending).toHaveBeenCalledWith("platform.apps");
  });

  it("says so when the ticket carries no tenant", () => {
    // parseTicketDetail coerces a missing tenant_id to "", so this is a real
    // payload shape, not a defensive branch.
    vi.mocked(isPending).mockReturnValue(false);
    render(<TenantLink productId="mark8ly" tenantId="" />);
    expect(screen.getByText("No tenant")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
