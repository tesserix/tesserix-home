import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchProductEntities = vi.fn();
const fetchPlatformSources = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchProductEntities: (...args: unknown[]) => fetchProductEntities(...args),
  fetchPlatformSources: () => fetchPlatformSources(),
}));

class NotFoundError extends Error {}
const notFound = vi.fn(() => {
  // Next's own `notFound()` throws to unwind the render, and the page relies
  // on that: everything after the call must not run.
  throw new NotFoundError("NEXT_NOT_FOUND");
});
// `useUrlFilters` (via `EntityIndex`) reads the router, which jsdom has no
// app-router context for — the same mock `kora/users/page.test.tsx` installs,
// plus `notFound` because this page is the one that calls it.
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/mark8ly/tenants",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { EntityPage, EntityRecord } from "@/lib/entities";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "@/components/kit/surface-state";
import {
  typeNotFederatedMessage,
  typeNotFederatedTitle,
} from "../federation-scope";
import ProductEntityIndexPage, {
  entityTypeLabel,
  entityState,
  readEntitySearch,
  unavailableMessage,
  unavailableTitle,
} from "./page";

/**
 * The page is a server component; its default export is an async function that
 * can be awaited and the result rendered — the same pattern
 * `[product]/page.test.tsx` and `kora/users/page.test.tsx` use.
 */
async function renderIndex(
  product: string,
  entity: string,
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  render(
    await ProductEntityIndexPage({
      params: Promise.resolve({ product, entity }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

function record(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "mark8ly:1",
    source: "mark8ly",
    type: "tenants",
    label: "Acme Retail",
    ...over,
  };
}

function page(data: readonly EntityRecord[], total = data.length): EntityPage {
  return { data, pagination: { page: 1, limit: 50, total } };
}

/** A deployment serving both of mark8ly's declared types, as
 *  `/v1/platform/sources` reports it. The default, so every pre-existing row
 *  runs against an estate that federates what it asks for. */
const MARK8LY_SERVED = {
  endpoints: { onboarding: ["mark8ly"] },
  entities: { tenants: ["mark8ly"], users: ["kora", "mark8ly"], foods: ["kora"] },
} as const;

beforeEach(() => {
  fetchPlatformSources.mockResolvedValue(MARK8LY_SERVED);
});

describe("readEntitySearch", () => {
  it("omits an absent or blank q rather than sending it", () => {
    // An absent `q` is a BROWSE — see `fetchProductEntities`. `q=` would
    // filter on the empty string on a product that treats the param as
    // present, so blank must be indistinguishable from absent here.
    expect(readEntitySearch({})).toBeUndefined();
    expect(readEntitySearch({ q: "" })).toBeUndefined();
    expect(readEntitySearch({ q: "   " })).toBeUndefined();
  });

  it("trims a real query, and ignores a repeated param", () => {
    expect(readEntitySearch({ q: "  acme " })).toBe("acme");
    // The endpoint takes one value per key, so honouring the first would
    // apply a filter the bar cannot show.
    expect(readEntitySearch({ q: ["a", "b"] })).toBeUndefined();
  });
});

describe("entityTypeLabel", () => {
  it("capitalises and de-underscores, and does nothing else", () => {
    expect(entityTypeLabel("tenants")).toBe("Tenants");
    expect(entityTypeLabel("gift_cards")).toBe("Gift cards");
    // Not "SKUs": the types are the product's vocabulary and the console
    // enumerates none of them, so re-casing would be a guess with no source.
    expect(entityTypeLabel("skus")).toBe("Skus");
  });

  it("falls back to the raw type rather than rendering a blank heading", () => {
    expect(entityTypeLabel("__")).toBe("__");
  });
});

describe("entityState", () => {
  it("is ready when rows arrived", () => {
    expect(
      entityState({ error: null, rows: [record()], filtered: false, label: "Mark8ly", type: "tenants" })
        .kind,
    ).toBe("ready");
  });

  it("maps a 501 to instrumentation-unavailable carrying this read's copy", () => {
    const state = entityState({
      error: new PlatformApiError("nope", 501),
      rows: [],
      filtered: false,
      label: "Mark8ly",
      type: "tenants",
    });
    expect(state).toEqual({
      kind: "instrumentation-unavailable",
      title: unavailableTitle("Mark8ly", "tenants"),
      message: unavailableMessage("Mark8ly"),
    });
  });

  it("leaves a 503 an error — the dangerous direction", () => {
    // 503 means the product could not be REACHED. Rendering it as "not
    // switched on" would tell an operator there are no records when there are
    // records that cannot be read.
    expect(
      entityState({
        error: new PlatformApiError("upstream down", 503),
        rows: [],
        filtered: false,
        label: "Mark8ly",
        type: "tenants",
      }).kind,
    ).toBe("error");
  });
});

describe("/mark8ly/tenants and /mark8ly/users, with no page file of their own", () => {
  it("lists mark8ly's tenant rows", async () => {
    fetchProductEntities.mockResolvedValue(
      page([
        record({ id: "mark8ly:1", label: "Acme Retail" }),
        record({ id: "mark8ly:2", label: "Brindle Books" }),
      ]),
    );

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.getByText("Brindle Books")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tenants" })).toBeInTheDocument();
  });

  it("lists mark8ly's user rows from the same file", async () => {
    fetchProductEntities.mockResolvedValue(
      page([record({ id: "mark8ly:9", type: "users", label: "Mahesh S", sublabel: "mahesh@" })]),
    );

    await renderIndex("mark8ly", "users");

    expect(screen.getByText("Mahesh S")).toBeInTheDocument();
    // The sublabel distinguishes two records sharing a label, and is rendered
    // only when the product sent one.
    expect(screen.getByText("mahesh@")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Users" })).toBeInTheDocument();
  });

  it("reads the product's federation slug and the declared type", async () => {
    // `source` equals the registry key for both products today, so this row
    // cannot distinguish `productSource(id)` from the raw param. It pins the
    // wire values the endpoint is given; `ProductEntry.source` is where the
    // two are allowed to diverge, and `products.test.ts` owns that.
    fetchProductEntities.mockResolvedValue(page([]));
    await renderIndex("mark8ly", "tenants");
    expect(fetchProductEntities).toHaveBeenCalledWith("mark8ly", "tenants", undefined, 1);
  });
});

describe("search and paging reach fetchProductEntities", () => {
  it("passes a trimmed search and the requested page", async () => {
    fetchProductEntities.mockResolvedValue(page([record()], 300));
    await renderIndex("mark8ly", "tenants", { q: "  acme ", page: "3" });
    expect(fetchProductEntities).toHaveBeenCalledWith("mark8ly", "tenants", "acme", 3);
  });

  it("OMITS a blank q rather than sending it — the browse case", async () => {
    fetchProductEntities.mockResolvedValue(page([record()]));
    await renderIndex("mark8ly", "tenants", { q: "   " });
    // `undefined`, so `fetchProductEntities` never sets the param. Asserted on
    // the call rather than on the rendered page, because a blank `q` sent to a
    // product that treats the param as present filters on the empty string and
    // the console cannot see that it happened.
    expect(fetchProductEntities).toHaveBeenCalledWith("mark8ly", "tenants", undefined, 1);
  });

  it("treats a non-numeric page as the first page rather than refusing it", async () => {
    fetchProductEntities.mockResolvedValue(page([record()]));
    await renderIndex("mark8ly", "tenants", { page: "abc" });
    expect(fetchProductEntities).toHaveBeenCalledWith("mark8ly", "tenants", undefined, 1);
  });

  it("keeps the search on the next page's link", async () => {
    // 300 rows, page 1 of 50 shown: there is a next page, and an operator who
    // clicks it must stay inside their search.
    fetchProductEntities.mockResolvedValue(page([record()], 300));
    await renderIndex("mark8ly", "tenants", { q: "acme" });
    const next = screen.getByRole("link", { name: /next/i });
    expect(next).toHaveAttribute("href", "/mark8ly/tenants?q=acme&page=2");
  });
});

describe("the states this surface renders", () => {
  it("renders a 501 with this read's copy, not the observability-park default", async () => {
    fetchProductEntities.mockRejectedValue(new PlatformApiError("entities: not served", 501));

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText(unavailableTitle("Mark8ly", "tenants"))).toBeInTheDocument();
    expect(screen.getByText(unavailableMessage("Mark8ly"))).toBeInTheDocument();
    expect(screen.queryByText(INSTRUMENTATION_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(document.body.textContent).not.toContain("observability-park");
  });

  it("renders a 503 as an error, never as 'not switched on'", async () => {
    fetchProductEntities.mockRejectedValue(new PlatformApiError("entities: upstream down", 503));

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText("Something Went Wrong")).toBeInTheDocument();
    expect(screen.getByText("entities: upstream down")).toBeInTheDocument();
    expect(screen.queryByText(unavailableTitle("Mark8ly", "tenants"))).toBeNull();
  });

  it("renders an unfederated product calmly, discarding the 400 it was sent", async () => {
    // The state #546 is about, at this surface: kora is federated here and
    // mark8ly is not, so `/v1/entities?source=mark8ly` is refused with
    // `ErrUnknownSource` → 400, which used to render as a failure. The two
    // reads go out together, so the refusal arrives and is DISCARDED rather
    // than avoided — the declarations say why, and they cost no extra hop.
    fetchPlatformSources.mockResolvedValue({ endpoints: {}, entities: { users: ["kora"] } });
    fetchProductEntities.mockRejectedValue(
      new PlatformApiError("entities: unknown source: mark8ly", 400),
    );

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText(typeNotFederatedTitle("Mark8ly", "tenants"))).toBeInTheDocument();
    expect(screen.getByText(typeNotFederatedMessage("Mark8ly", "tenants"))).toBeInTheDocument();
    expect(screen.queryByText("Something Went Wrong")).toBeNull();
    expect(document.body.textContent).not.toContain("entities: unknown source");
    expect(document.body.textContent).not.toContain("observability-park");
  });

  it("covers a federated product that did not declare THIS type", async () => {
    // `ErrTypeNotServed` rather than `ErrUnknownSource` — mark8ly is federated
    // and serves `users`, but not `tenants`. Both are 400s and both are the
    // same calm state, which is why the copy is true of either.
    fetchPlatformSources.mockResolvedValue({
      endpoints: { onboarding: ["mark8ly"] },
      entities: { users: ["mark8ly"] },
    });
    fetchProductEntities.mockRejectedValue(
      new PlatformApiError('entities: mark8ly does not serve "tenants"', 400),
    );

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText(typeNotFederatedTitle("Mark8ly", "tenants"))).toBeInTheDocument();
  });

  it("shows real rows even when the declarations say the slug is undeclared", async () => {
    // The two reads gate on the same configuration, so this should not be
    // reachable. If they ever disagree, hiding records that exist behind "not
    // switched on" is the dangerous direction — the same mistake as rendering
    // a 503 as "no metrics" — so the rows win.
    fetchPlatformSources.mockResolvedValue({ endpoints: {}, entities: { users: ["kora"] } });
    fetchProductEntities.mockResolvedValue(page([record({ label: "Acme Retail" })]));

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.queryByText(typeNotFederatedTitle("Mark8ly", "tenants"))).toBeNull();
  });

  it("reports the failure when BOTH reads fail, rather than calling it not federated", async () => {
    // The `null` is not `false` rule, on the branch that has nothing else to
    // pin it. Before the two reads were parallelised, "we never asked" was
    // asserted by `fetchProductEntities` not being called; now both reads go
    // out, so an estate-wide outage lands here with no declarations to read
    // AND no records. Treating an unread `sources` as "not federated" would
    // print "nothing is wrong" over a platform API that is down.
    fetchPlatformSources.mockRejectedValue(new PlatformApiError("sources: down", 503));
    fetchProductEntities.mockRejectedValue(new PlatformApiError("entities: down", 503));

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText("Something Went Wrong")).toBeInTheDocument();
    expect(screen.getByText("entities: down")).toBeInTheDocument();
    expect(screen.queryByText(typeNotFederatedTitle("Mark8ly", "tenants"))).toBeNull();
  });

  it("keeps a 400 an error on a slug the deployment DOES declare", async () => {
    // The discard is not "swallow every 400". A product that is federated and
    // serves this type refusing the read is a real failure — a search the
    // product rejected, say — and must still be reported.
    fetchProductEntities.mockRejectedValue(
      new PlatformApiError("the product refused this read: invalid_input", 400),
    );

    await renderIndex("mark8ly", "tenants");

    expect(screen.getByText("Something Went Wrong")).toBeInTheDocument();
    expect(screen.getByText("the product refused this read: invalid_input")).toBeInTheDocument();
  });

  it("reads anyway when the declarations could not be read", async () => {
    // A failed sources read is the absence of a fact, not the fact that
    // nothing is declared. Blocking the index on it would replace a working
    // page with a callout whenever a secondary read blinked.
    fetchPlatformSources.mockRejectedValue(new PlatformApiError("sources: down", 503));
    fetchProductEntities.mockResolvedValue(page([record({ label: "Acme Retail" })]));

    await renderIndex("mark8ly", "tenants");

    expect(fetchProductEntities).toHaveBeenCalledWith("mark8ly", "tenants", undefined, 1);
    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.queryByText(typeNotFederatedTitle("Mark8ly", "tenants"))).toBeNull();
  });

  it("names the product and type in the empty message", async () => {
    fetchProductEntities.mockResolvedValue(page([]));
    await renderIndex("mark8ly", "tenants");
    expect(screen.getByText("Mark8ly has no tenants yet.")).toBeInTheDocument();
  });
});

describe("what this page refuses, before any read", () => {
  it("answers not-found for an undeclared entity type on a real product", async () => {
    fetchProductEntities.mockClear();
    // An undeclared type must not reach platform-api: it answers 400
    // (`ErrTypeNotServed`) before calling the product, and a 400 is not a
    // state this page renders. `foods` is Kora's type, not mark8ly's, so it is
    // a real declaration boundary rather than a made-up string.
    await expect(renderIndex("mark8ly", "foods")).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalled();
    expect(fetchProductEntities).not.toHaveBeenCalled();
  });

  it("answers not-found for `platform`, which routing now sends here", async () => {
    fetchProductEntities.mockClear();
    // `routing.test.ts` measures that `/platform/nope` reaches this page now
    // that a two-segment dynamic route exists — before it, it matched nothing.
    // `platform` is not in `PRODUCT_IDS` and must not become one.
    await expect(renderIndex("platform", "tenants")).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchProductEntities).not.toHaveBeenCalled();
  });

  it("answers not-found for a product the console does not serve", async () => {
    fetchProductEntities.mockClear();
    await expect(renderIndex("homechef", "users")).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchProductEntities).not.toHaveBeenCalled();
  });

  it("would render kora's declared types, so routing — not this check — is what keeps Kora bespoke", async () => {
    // `/kora/users` and `/kora/foods` resolve to Kora's own page files (see
    // `routing.test.ts`), so this page never serves them in a real request.
    // It would render them if asked, which is what makes the routing test the
    // guard rather than this one — asserted here so a reader does not mistake
    // the param check for that guard.
    fetchProductEntities.mockResolvedValue(page([record({ source: "kora", type: "users" })]));
    await renderIndex("kora", "users");
    expect(fetchProductEntities).toHaveBeenCalledWith("kora", "users", undefined, 1);
  });
});
