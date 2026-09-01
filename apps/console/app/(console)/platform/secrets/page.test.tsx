import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchSecretsInventory = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchSecretsInventory: (...args: unknown[]) => fetchSecretsInventory(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import type { SecretsInventory } from "@/lib/secrets";
import SecretsInventoryPage, {
  emptyMessageFor,
  SECRETS_EMPTY_MESSAGE,
  SECRETS_UNAVAILABLE_TITLE,
  secretsReadError,
  secretsState,
} from "./page";
import { secretDetailHref, SecretsTable } from "./secrets-table";

// The page is a server component, exercised the same way `outbox/page.test.tsx`
// exercises its sibling: its default export is awaited and rendered directly,
// and its logic is exercised through the exported pure functions. The client
// table is rendered directly for the row/count/filter tests below.

const inventory = (over: Partial<SecretsInventory> = {}): SecretsInventory => ({
  rows: [
    { path: "kv/data/mark8ly/stripe", store: "openbao", hasReader: false },
    { path: "prod-zitadel-console-client-secret", store: "gcpsm", hasReader: null },
  ],
  counts: { all: 2, openbao: 1, gcpsm: 1, noReader: 1 },
  complete: true,
  ...over,
});

describe("row-level reader flag", () => {
  // The property Addition 1 exists to hold: `null` (GSM, "not knowable here")
  // must never render as an orphan. Only a `false` (OpenBao) row does.
  it("marks an orphaned OpenBao row and does not mark a GSM row", () => {
    const data = inventory();
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    // Exactly one row is flagged as having no reader — the OpenBao orphan.
    expect(screen.getAllByText("No reader")).toHaveLength(1);
    // The GSM row renders its own, distinct chip — never the orphan chip.
    expect(screen.getByText("Access via IAM")).toBeInTheDocument();
  });
});

// `secretDetailHref` is the only producer of the `?store=` param that
// `parseStoreParam` (`[...path]/page.tsx`) fails closed on — an absent or
// unrecognised value 404s rather than defaulting to openbao. Pinning the
// exact href here, and round-tripping its query string back through
// `parseStoreParam`, is what actually closes the loop between the two
// tasks: a change to either side's param name or encoding would show up
// here instead of only at request time in a real deployment.
describe("secretDetailHref", () => {
  it("builds the exact detail route href for a row", () => {
    expect(secretDetailHref({ path: "mark8ly/homechef-api/db-password", store: "openbao" })).toBe(
      "/platform/secrets/mark8ly/homechef-api/db-password?store=openbao",
    );
  });

  it("encodes a store value's query string so parseStoreParam reads it back", async () => {
    const { parseStoreParam } = await import("./[...path]/page");
    const href = secretDetailHref({ path: "mark8ly/db-password", store: "gcpsm" });
    const store = new URL(href, "https://example.test").searchParams.get("store");
    expect(store).toBe("gcpsm");
    expect(parseStoreParam(store ?? undefined)).toBe("gcpsm");
  });
});

describe("counts", () => {
  // The property that must survive filtering: the counts row answers "how
  // many across the whole estate", never "how many are currently shown".
  it("renders from `counts`, not from the rendered row count", () => {
    const data = inventory({
      rows: [{ path: "only/one/row", store: "openbao", hasReader: false }],
      counts: { all: 9, openbao: 5, gcpsm: 4, noReader: 7 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    expect(screen.getByRole("button", { name: /All \(9\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenBao \(5\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Google Secret Manager \(4\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No reader \(7\)/ })).toBeInTheDocument();
  });
});

describe("empty state", () => {
  it("renders when there are no secrets", () => {
    const data = inventory({
      rows: [],
      counts: { all: 0, openbao: 0, gcpsm: 0, noReader: 0 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    expect(screen.getByText(SECRETS_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("renders end-to-end through the page when the read succeeds with no rows", async () => {
    fetchSecretsInventory.mockResolvedValue(
      inventory({ rows: [], counts: { all: 0, openbao: 0, gcpsm: 0, noReader: 0 } }),
    );
    render(await SecretsInventoryPage());
    expect(screen.getByText(SECRETS_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  // Finding 3 of the whole-branch review: an empty `rows` with `complete:
  // false` must not render the all-clear message beneath a callout that says
  // the list may be short — the two would contradict each other on screen.
  describe("when the walk was cut short", () => {
    it("emptyMessageFor returns the qualified message, not the all-clear", () => {
      const message = emptyMessageFor({ complete: false });
      expect(message).not.toBe(SECRETS_EMPTY_MESSAGE);
      expect(message).toMatch(/cut short/i);
    });

    it("emptyMessageFor returns the all-clear when the walk finished", () => {
      expect(emptyMessageFor({ complete: true })).toBe(SECRETS_EMPTY_MESSAGE);
    });

    it("renders the qualified message end-to-end, never the all-clear", async () => {
      fetchSecretsInventory.mockResolvedValue(
        inventory({ rows: [], counts: { all: 0, openbao: 0, gcpsm: 0, noReader: 0 }, complete: false }),
      );
      render(await SecretsInventoryPage());
      expect(screen.queryByText(SECRETS_EMPTY_MESSAGE)).toBeNull();
      expect(screen.getByText(/cut short/i)).toBeInTheDocument();
      expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
    });
  });
});

describe("the secrets-api 501", () => {
  it("resolves to the instrumentation-unavailable state, not an error", () => {
    const state = secretsState({
      error: new PlatformApiError("backends: SECRETS_API_ORIGIN is not set", 501),
      rows: [],
    });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("renders this surface's own 'not configured' copy, not the kit's observability default", () => {
    const state = secretsState({
      error: new PlatformApiError("backends: SECRETS_API_ORIGIN is not set", 501),
      rows: [],
    });
    render(
      <SecretsTable
        inventory={inventory({ rows: [] })}
        state={state}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    expect(screen.getByText(SECRETS_UNAVAILABLE_TITLE)).toBeInTheDocument();
  });

  it("renders the 'not configured' state end-to-end rather than throwing", async () => {
    fetchSecretsInventory.mockRejectedValue(
      new PlatformApiError("backends: SECRETS_API_ORIGIN is not set", 501),
    );
    render(await SecretsInventoryPage());
    expect(screen.getByText(SECRETS_UNAVAILABLE_TITLE)).toBeInTheDocument();
  });

  it("leaves a real failure alone rather than dressing it up as a 501", () => {
    const surfaced = secretsReadError(new PlatformApiError("boom", 502));
    expect(surfaced?.unavailable).toBeUndefined();
  });
});

describe("completeness", () => {
  it("renders the incompleteness notice when the walk was cut short", () => {
    const data = inventory({ complete: false });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
  });

  it("renders nothing extra when the walk reached every leaf", () => {
    const data = inventory({ complete: true });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );
    expect(screen.queryByText(/may be incomplete/i)).toBeNull();
  });
});
