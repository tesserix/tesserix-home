import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SecretsInventory } from "@/lib/secrets";
import { SecretsTable } from "./secrets-table";

/**
 * `next/link`, stamped with the props the real one swallows.
 *
 * jsdom cannot observe a prefetch, and `<Link>` and `<a>` render identically
 * here, so `prefetch` is re-emitted as an attribute. That is what makes the
 * assertion below one about the rendered output rather than about the source
 * text. Same device as `components/kit/states.render.test.tsx`.
 */
vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => (
    <a data-next-link="true" data-prefetch={String(prefetch)} {...props} />
  ),
}));

const INVENTORY: SecretsInventory = {
  rows: [
    { path: "prod/one", store: "openbao", hasReader: true },
    { path: "prod/two", store: "gcpsm", hasReader: null },
  ],
  counts: { all: 2, openbao: 1, gcpsm: 1, noReader: 0 },
  complete: true,
};

describe("the secrets inventory rows", () => {
  // The inventory is ~600 rows and the detail route is fully dynamic, fanning
  // out to fetchSecretDetail + fetchSecretVersions + fetchGrants. Left to
  // Next's viewport heuristic, scrolling the table alone would bill
  // secrets-api three calls per row an operator never clicks (#500). The prop
  // is one word and deleting it is silent, which is why it is pinned here.
  it("does not prefetch the detail route", () => {
    render(
      <SecretsTable
        inventory={INVENTORY}
        state={{ kind: "ready" }}
        emptyMessage="no secrets"
        reauthReturnTo="/platform/secrets"
      />,
    );

    const links = screen.getAllByRole("link", { name: /^prod\// });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("data-prefetch", "false");
    }
  });
});
