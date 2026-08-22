import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InternalTools } from "./internal-tools";
import type { ToolsDirectory } from "@/lib/tools-directory";

const directory = (source: ToolsDirectory["source"]): ToolsDirectory => ({
  source,
  groups: [
    { key: "identity", label: "Identity and secrets" },
    { key: "cost", label: "Cost" },
  ],
  tools: [
    { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.", note: null, groupKey: "identity" },
    { id: "2", name: "Kubecost", subdomain: "kubecost", purpose: "Spend.", note: null, groupKey: "cost" },
  ],
});

describe("InternalTools", () => {
  it("derives each link from the configured base domain", () => {
    render(<InternalTools baseDomain="dev.tesserix.app" directory={directory("platform-api")} />);

    // The property the whole schema protects: a non-production console must
    // not hand operators links into production.
    expect(screen.getByRole("link", { name: /Zitadel/ })).toHaveAttribute(
      "href",
      "https://auth.dev.tesserix.app",
    );
  });

  it("says nothing about its source when the API answered", () => {
    render(<InternalTools baseDomain="tesserix.app" directory={directory("platform-api")} />);

    expect(screen.queryByText(/built-in list/i)).not.toBeInTheDocument();
  });

  it("says nothing when the phase is off on purpose (PLATFORM_API_ORIGIN unset)", () => {
    render(<InternalTools baseDomain="tesserix.app" directory={directory("builtin")} />);

    // Unsetting the variable must restore the pre-#318 page byte-for-byte.
    // A banner here would be false: nothing is broken, the phase was simply
    // never switched on. This is the case the two-valued `source` used to
    // conflate with "degraded" and wrongly banner.
    expect(screen.queryByText(/built-in list/i)).not.toBeInTheDocument();
  });

  it("says so when the live directory is unreachable (degraded)", () => {
    render(<InternalTools baseDomain="tesserix.app" directory={directory("degraded")} />);

    // The cost of a fallback is two lists that can disagree. This is what
    // stops them disagreeing SILENTLY.
    expect(screen.getByText(/built-in list/i)).toBeInTheDocument();
  });

  it("skips a group with no tools rather than rendering a bare heading", () => {
    const empty: ToolsDirectory = {
      source: "platform-api",
      groups: [{ key: "identity", label: "Identity and secrets" }, { key: "ghost", label: "Ghost" }],
      tools: [
        { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.", note: null, groupKey: "identity" },
      ],
    };

    render(<InternalTools baseDomain="tesserix.app" directory={empty} />);

    // A heading over nothing reads as a loading failure rather than an
    // absence. This belt used to be backed by a data test that made the case
    // impossible; with groups in a table it is the only thing left.
    expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
    expect(screen.getByText("Identity and secrets")).toBeInTheDocument();
  });
});
