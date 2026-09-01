import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchSecretDetail = vi.fn();
const fetchSecretVersions = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchSecretDetail: (...args: unknown[]) => fetchSecretDetail(...args),
  fetchSecretVersions: (...args: unknown[]) => fetchSecretVersions(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import type { SecretDetail, SecretVersion } from "@/lib/secrets";
import SecretDetailPage, { detailState, parseStoreParam } from "./page";

// The page is a server component, exercised the same way every other detail
// route in this app is (tickets/[id], crm/[organisation]): its default export
// is awaited and rendered directly, and `notFound()` — real, not mocked — is
// asserted on by its thrown digest rather than by mocking `next/navigation`.

function renderPage(input: {
  path: string[];
  store?: string;
}) {
  return SecretDetailPage({
    params: Promise.resolve({ path: input.path }),
    searchParams: Promise.resolve({ store: input.store }),
  });
}

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404"),
  });
}

const DETAIL: SecretDetail = {
  path: "homechef/homechef-api/db-password",
  version: 3,
  keys: ["url", "username", "password"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

const VERSIONS: SecretVersion[] = [
  { version: 1, createdAt: "2025-12-01T00:00:00.000Z", destroyed: true, deleted: true },
  { version: 2, createdAt: "2026-01-01T00:00:00.000Z", destroyed: false, deleted: true },
  { version: 3, createdAt: "2026-02-01T00:00:00.000Z", destroyed: false, deleted: false },
];

beforeEach(() => {
  fetchSecretDetail.mockReset();
  fetchSecretVersions.mockReset();
});

describe("parseStoreParam", () => {
  it("accepts a known store", () => {
    expect(parseStoreParam("openbao")).toBe("openbao");
    expect(parseStoreParam("gcpsm")).toBe("gcpsm");
  });

  it("rejects an absent store rather than defaulting to openbao", () => {
    expect(parseStoreParam(undefined)).toBeNull();
  });

  it("rejects an unknown store rather than defaulting to openbao", () => {
    expect(parseStoreParam("vault")).toBeNull();
  });
});

describe("detailState", () => {
  it("reports empty — not ready — when the detail never arrived", () => {
    expect(detailState({ error: null, detail: null })).toEqual({ kind: "empty" });
  });

  it("reports ready once there is a record", () => {
    expect(detailState({ error: null, detail: DETAIL })).toEqual({ kind: "ready" });
  });

  it("prefers the error over the missing record", () => {
    expect(
      detailState({ error: new PlatformApiError("boom", 500), detail: null }).kind,
    ).toBe("error");
  });
});

describe("the secret detail surface", () => {
  it("renders the path, current version, and key names — never a value", async () => {
    fetchSecretDetail.mockResolvedValue(DETAIL);
    fetchSecretVersions.mockResolvedValue([]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    // The path and the current version each appear twice by design — once in
    // the page title/breadcrumb (or the versions table) and once in the
    // summary rail — so this asserts presence, not a single match.
    expect(screen.getAllByText("homechef/homechef-api/db-password").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "homechef/homechef-api/db-password" })).toBeInTheDocument();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("url")).toBeInTheDocument();
    expect(screen.getByText("username")).toBeInTheDocument();
    expect(screen.getByText("password")).toBeInTheDocument();
  });

  it("distinguishes a destroyed version from a merely deleted one", async () => {
    fetchSecretDetail.mockResolvedValue(DETAIL);
    fetchSecretVersions.mockResolvedValue(VERSIONS);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    // Three distinct labels, not two rows both reading "Deleted" or both
    // reading "Destroyed" — collapsing the two facts is exactly the mutation
    // this test exists to catch.
    expect(screen.getByText("Destroyed")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryAllByText("Destroyed")).toHaveLength(1);
    expect(screen.queryAllByText("Deleted")).toHaveLength(1);
  });

  it("renders the not-found state when the store parameter is absent", async () => {
    await expectNotFound(
      renderPage({ path: ["homechef", "homechef-api", "db-password"] }),
    );
    expect(fetchSecretDetail).not.toHaveBeenCalled();
  });

  it("renders the not-found state when the store parameter is unknown, never defaulting to openbao", async () => {
    await expectNotFound(
      renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "vault" }),
    );
    expect(fetchSecretDetail).not.toHaveBeenCalled();
  });

  it("renders the not-found state on a PlatformApiError 404, rather than throwing an unhandled error", async () => {
    fetchSecretDetail.mockRejectedValue(new PlatformApiError("not found", 404));
    fetchSecretVersions.mockResolvedValue([]);

    await expectNotFound(
      renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }),
    );
  });
});
