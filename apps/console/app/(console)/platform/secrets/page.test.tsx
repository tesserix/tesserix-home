import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchSecretsInventory = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchSecretsInventory: (...args: unknown[]) => fetchSecretsInventory(...args),
}));

// `getCurrentSession` and `requiresCapability` back the New secret action's
// render-path gate. Mocked because the real `getCurrentSession` reads the
// request's cookies, which do not exist when a server component is awaited
// directly. `hasCapability` is deliberately NOT mocked, matching
// `[...path]/page.test.tsx` — the gate tests below are evidence about the
// real capability decision, not a stand-in for it.
const getCurrentSession = vi.fn();
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: (...args: unknown[]) => getCurrentSession(...args),
}));

const requiresCapability = vi.fn((..._args: unknown[]) => true);
vi.mock("@/lib/internal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/internal-access")>()),
  requiresCapability: (...args: unknown[]) => requiresCapability(...args),
}));

beforeEach(() => {
  getCurrentSession.mockReset();
  getCurrentSession.mockResolvedValue(null);
  requiresCapability.mockReset();
  requiresCapability.mockReturnValue(true);
});

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

  // The same property one level UP from the chip. `matchesFilter` holds its
  // own, second copy of the `hasReader === false` comparison, and that copy
  // was unpinned: relaxing it to `!row.hasReader` — the exact slip its
  // neighbouring comment warns about — left all 23 tests in this file green
  // while sweeping every Google Secret Manager row into a filter named for
  // the alarm this whole surface exists to raise. The chip test above cannot
  // catch it, because the chip and the filter read `hasReader` independently.
  it("narrows the No reader filter to hasReader === false, never to a GSM null", async () => {
    const user = userEvent.setup();
    const data = inventory({
      rows: [
        { path: "kv/data/mark8ly/stripe", store: "openbao", hasReader: false },
        { path: "kv/data/mark8ly/sendgrid", store: "openbao", hasReader: true },
        { path: "prod-zitadel-console-client-secret", store: "gcpsm", hasReader: null },
      ],
      counts: { all: 3, openbao: 2, gcpsm: 1, noReader: 1 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    await user.click(screen.getByRole("button", { name: /No reader \(1\)/ }));

    // The genuine orphan — an OpenBao secret with no grant — is the only row
    // this filter is for.
    expect(screen.getByText("kv/data/mark8ly/stripe")).toBeInTheDocument();
    // `null` means "the console cannot see GSM's IAM bindings", not "nothing
    // can read this". A GSM row surfacing here is the false alarm.
    expect(screen.queryByText("prod-zitadel-console-client-secret")).toBeNull();
    expect(screen.queryByText("kv/data/mark8ly/sendgrid")).toBeNull();
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

describe("path search", () => {
  // The property this surface exists to add: finding one row among 602
  // without scrolling. Matches on `path` only, case-insensitively, and never
  // touches `counts` — see the "counts must not move" test below for that
  // half of the contract.
  const rows = [
    { path: "kv/data/mark8ly/stripe", store: "openbao" as const, hasReader: false },
    { path: "kv/data/mark8ly/sendgrid", store: "openbao" as const, hasReader: true },
    { path: "prod-STRIPE-webhook-secret", store: "gcpsm" as const, hasReader: null },
  ];

  it("filters rows to a case-insensitive substring match on path", async () => {
    const user = userEvent.setup();
    const data = inventory({
      rows,
      counts: { all: 3, openbao: 2, gcpsm: 1, noReader: 1 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: /search by path/i }), "stripe");

    // Matches both the openbao and the gcpsm row despite the differing case
    // of the query against "STRIPE" — a case-sensitive match would drop the
    // second row.
    expect(screen.getByText("kv/data/mark8ly/stripe")).toBeInTheDocument();
    expect(screen.getByText("prod-STRIPE-webhook-secret")).toBeInTheDocument();
    // The row whose path does not contain "stripe" must be gone.
    expect(screen.queryByText("kv/data/mark8ly/sendgrid")).toBeNull();
  });

  it("composes with the store chip as AND, not OR", async () => {
    const user = userEvent.setup();
    const data = inventory({
      rows,
      counts: { all: 3, openbao: 2, gcpsm: 1, noReader: 1 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    // "stripe" matches a row in both stores; the OpenBao chip should narrow
    // that down to only the OpenBao match, not restore the GSM one.
    await user.click(screen.getByRole("button", { name: /OpenBao \(2\)/ }));
    await user.type(screen.getByRole("searchbox", { name: /search by path/i }), "stripe");

    expect(screen.getByText("kv/data/mark8ly/stripe")).toBeInTheDocument();
    expect(screen.queryByText("prod-STRIPE-webhook-secret")).toBeNull();
    expect(screen.queryByText("kv/data/mark8ly/sendgrid")).toBeNull();
  });

  it("never filters the counts row — they stay pinned to the whole estate", async () => {
    const user = userEvent.setup();
    const data = inventory({
      rows,
      counts: { all: 3, openbao: 2, gcpsm: 1, noReader: 1 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    // A query matching exactly one of three rows would move every count to 1
    // if the counts were derived from the filtered view instead of `counts`.
    await user.type(screen.getByRole("searchbox", { name: /search by path/i }), "sendgrid");

    expect(screen.getByRole("button", { name: /All \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenBao \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Google Secret Manager \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No reader \(1\)/ })).toBeInTheDocument();
  });

  it("shows the search-specific empty message once a query matches nothing", async () => {
    const user = userEvent.setup();
    const data = inventory({ rows, counts: { all: 3, openbao: 2, gcpsm: 1, noReader: 1 } });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: /search by path/i }), "no-such-secret");

    expect(screen.getByText("No secrets match this search.")).toBeInTheDocument();
    expect(screen.queryByText("No secrets match this filter.")).toBeNull();
  });

  it("shows the filter-only empty message when no query is typed", async () => {
    const user = userEvent.setup();
    const data = inventory({
      rows: [{ path: "only/row", store: "gcpsm" as const, hasReader: null }],
      counts: { all: 1, openbao: 0, gcpsm: 1, noReader: 0 },
    });
    render(
      <SecretsTable
        inventory={data}
        state={secretsState({ error: null, rows: data.rows })}
        emptyMessage={SECRETS_EMPTY_MESSAGE}
        reauthReturnTo="/platform/secrets"
      />,
    );

    await user.click(screen.getByRole("button", { name: /OpenBao \(0\)/ }));

    expect(screen.getByText("No secrets match this filter.")).toBeInTheDocument();
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

describe("the way in to creating a secret", () => {
  // The entry point whose absence is the bug this whole change closes: the
  // write form has always had a create mode and nothing could reach it,
  // because `[...path]/page.tsx` turns a 404 into `notFound()`.
  function signIn(roles: readonly string[]) {
    getCurrentSession.mockResolvedValue({
      sub: "operator-1",
      email: "ava@tesserix.app",
      roles,
      iat: 0,
      exp: 0,
    });
  }

  beforeEach(() => {
    fetchSecretsInventory.mockResolvedValue(inventory());
  });

  it("offers New secret, pointing at the create route, to a fully capable operator", async () => {
    signIn(["platform", "rotate-credentials"]);

    render(await SecretsInventoryPage());

    // The href is asserted, not just the label: a New secret button linking
    // anywhere else is exactly as broken as no button at all, and the create
    // route is unreachable by any other means.
    expect(screen.getByRole("link", { name: "New secret" })).toHaveAttribute(
      "href",
      "/platform/secrets/new",
    );
  });

  it("does not offer it to a platform-only operator", async () => {
    // `PUT /api/secrets/*path` sits in secrets-api's `live` tier and needs
    // `rotate-credentials` too, so offering this operator the control would
    // walk them into a page that can only tell them no.
    signIn(["platform"]);

    render(await SecretsInventoryPage());

    expect(screen.queryByRole("link", { name: "New secret" })).toBeNull();
  });

  it("offers it before cutover, when no provider requires capabilities", async () => {
    // `requiresCapability()` is false under `google`, where sessions carry no
    // roles at all — the gate must not hide the control from every operator
    // on deploy.
    requiresCapability.mockReturnValue(false);
    getCurrentSession.mockResolvedValue(null);

    render(await SecretsInventoryPage());

    expect(screen.getByRole("link", { name: "New secret" })).toBeInTheDocument();
  });
});
