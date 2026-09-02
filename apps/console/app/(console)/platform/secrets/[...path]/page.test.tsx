import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchSecretDetail = vi.fn();
const fetchSecretVersions = vi.fn();
const fetchGrants = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchSecretDetail: (...args: unknown[]) => fetchSecretDetail(...args),
  fetchSecretVersions: (...args: unknown[]) => fetchSecretVersions(...args),
  fetchGrants: (...args: unknown[]) => fetchGrants(...args),
}));

// `getCurrentSession` and `requiresCapability` back the write-affordance gate
// below. `hasCapability` itself is NOT mocked — same reasoning
// `billing/catalog/page.test.tsx` gives: a passing gate test here is evidence
// about the real capability decision, not a stand-in for it.
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

// `AccessCard` (Task 4) calls `useRouter()` to re-read after a grant/revoke
// — `notFound()` stays real (see the note below on why it is asserted by
// its thrown digest), so only `useRouter` is stood in here, via
// `importOriginal` for everything else `next/navigation` exports.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
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
  fetchGrants.mockReset();
  fetchGrants.mockResolvedValue([]);
  getCurrentSession.mockReset();
  getCurrentSession.mockResolvedValue(null);
  requiresCapability.mockReset();
  requiresCapability.mockReturnValue(true);
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

  // `parseSecretDetail`/`parseSecretVersions` (`lib/secrets.ts`) map Go's
  // serialised zero `time.Time` to `undefined`, which is what makes these
  // fallbacks reachable at all — before that fix, a zero timestamp read as a
  // truthy string and this branch never rendered. `fetchSecretDetail`/
  // `fetchSecretVersions` are mocked here (this suite exercises the render,
  // not the parser — `secrets.test.ts` covers the parser itself), but the
  // detail handed back is already the PARSED shape (`undefined`, not the
  // zero-time string) — exactly what the real parser would hand this
  // component after Task's fix.
  it("omits Created/Updated from the summary, and renders 'Not recorded' for a version, when timestamps are absent", async () => {
    fetchSecretDetail.mockResolvedValue({
      path: "homechef/homechef-api/db-password",
      version: 1,
      keys: ["password"],
      // createdAt/updatedAt omitted entirely — the parsed shape for a zero
      // time.Time, per `parseSecretDetail`.
    });
    fetchSecretVersions.mockResolvedValue([
      { version: 1, createdAt: undefined, destroyed: false, deleted: false },
    ]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    // "Created" also labels a column header in the Versions table below, so
    // this checks the summary rail's own `<dt>` labels specifically rather
    // than any occurrence of the word on the page.
    const summaryLabels = screen.getAllByRole("term").map((el) => el.textContent);
    expect(summaryLabels).not.toContain("Created");
    expect(summaryLabels).not.toContain("Updated");
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
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

describe("the access card", () => {
  // The tab's content only mounts once selected (`@tesserix/web`'s
  // `TabsContent` returns `null` for every tab but the active one), so every
  // assertion below clicks into "Access" first — same pattern as
  // `crm/[organisation]/page.test.tsx`'s "Contacts" tab.
  async function openAccessTab() {
    await userEvent.click(screen.getByRole("tab", { name: "Access" }));
  }

  beforeEach(() => {
    fetchSecretDetail.mockResolvedValue(DETAIL);
    fetchSecretVersions.mockResolvedValue([]);
  });

  it("flags an OpenBao secret with no covering grant", async () => {
    fetchGrants.mockResolvedValue([]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));
    await openAccessTab();

    expect(screen.getByText("Nothing reads this secret yet.")).toBeInTheDocument();
    expect(screen.getByText("No app can read this")).toBeInTheDocument();
  });

  it("counts a single covering grant as '1 reader'", async () => {
    fetchGrants.mockResolvedValue([{ namespace: "homechef", app: "homechef-api" }]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));
    await openAccessTab();

    expect(screen.getByText("1 reader")).toBeInTheDocument();
    expect(screen.getByText("homechef/homechef-api")).toBeInTheDocument();
    expect(screen.queryByText("Nothing reads this secret yet.")).toBeNull();
  });

  it("counts two covering grants as '2 readers'", async () => {
    // `readersFor` matches by prefix (`lib/secrets.ts`), so two DISTINCT
    // grants covering one path need two distinct prefixes along it — a
    // route one level deeper than the other tests here, matching
    // `readersFor`'s own "grant on a parent prefix" fixture
    // (`lib/secrets.test.ts`). Only the route segments matter for this
    // match; `fetchSecretDetail`'s resolved `DETAIL.path` is unrelated and
    // never compared against it.
    fetchGrants.mockResolvedValue([
      { namespace: "homechef", app: "homechef-api" },
      { namespace: "homechef", app: "homechef-api/nested" },
    ]);

    render(
      await renderPage({
        path: ["homechef", "homechef-api", "nested", "db-password"],
        store: "openbao",
      }),
    );
    await openAccessTab();

    expect(screen.getByText("2 readers")).toBeInTheDocument();
  });

  // The failure mode this guards against is both cards rendering at once —
  // asserting only that the IAM copy is present would still pass then, so
  // this checks both directions.
  it("replaces the access card with the IAM card for a GSM secret, never rendering an empty reader list", async () => {
    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "gcpsm" }));
    await openAccessTab();

    // A single element containing this exact sentence, split across a
    // `<strong>` and a `<code>`, does not exist as one text node — checking
    // the rendered body's full text is the honest way to assert on it.
    expect(document.body.textContent).toContain(
      "Governed by Google Cloud IAM, not from here. This store has no whitelist in tesserix-k8s, so there is nothing for the console to propose.",
    );
    expect(screen.queryByText("Nothing reads this secret yet.")).toBeNull();

    // GSM never calls the OpenBao-only grants route at all.
    expect(fetchGrants).not.toHaveBeenCalled();
  });

  it("renders no reader chip at all for a GSM secret", async () => {
    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "gcpsm" }));
    await openAccessTab();

    expect(screen.queryByText("No app can read this")).toBeNull();
    expect(screen.queryByText(/^\d+ readers?$/)).toBeNull();
  });
});

describe("the write affordance gate", () => {
  // Writing requires BOTH `platform` and `rotate-credentials` — `secrets-api`
  // enforces that itself on `PUT /api/secrets/*path`, so this gate is never
  // the thing stopping a write. It only decides whether an operator sees a
  // control that would 403 if they clicked it.
  beforeEach(() => {
    fetchSecretDetail.mockResolvedValue(DETAIL);
    fetchSecretVersions.mockResolvedValue([]);
  });

  function signIn(roles: readonly string[]) {
    getCurrentSession.mockResolvedValue({
      sub: "operator-1",
      email: "op@tesserix.app",
      roles,
      iat: 0,
      exp: 0,
    });
  }

  it("shows the write form to an operator holding platform and rotate-credentials", async () => {
    signIn(["platform", "rotate-credentials"]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    expect(screen.getByRole("tab", { name: "Write" })).toBeInTheDocument();
  });

  it("withholds the write form from a platform-only operator, and the detail still renders", async () => {
    signIn(["platform"]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    expect(screen.queryByRole("tab", { name: "Write" })).toBeNull();
    // Losing the detail would be the worse bug — hiding the write control
    // must never take the rest of the page with it.
    expect(screen.getByRole("heading", { name: "homechef/homechef-api/db-password" })).toBeInTheDocument();
    expect(screen.getByText("url")).toBeInTheDocument();
  });

  // The Versions tab is the default tab, so these need no click. `VERSIONS`
  // carries one row of each lifecycle state, which is what makes "exactly
  // one Restore button" a real assertion rather than a coincidence.
  it("offers Restore only on the deleted-but-not-destroyed version, for an operator who can write", async () => {
    signIn(["platform", "rotate-credentials"]);
    fetchSecretVersions.mockResolvedValue(VERSIONS);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    expect(screen.getByRole("button", { name: "Restore version 2" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Restore version/ })).toHaveLength(1);
  });

  it("withholds Restore from a platform-only operator, and the Versions table still renders", async () => {
    signIn(["platform"]);
    fetchSecretVersions.mockResolvedValue(VERSIONS);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    expect(screen.queryByRole("button", { name: /^Restore version/ })).toBeNull();
    // Hiding the control must never take the table with it — the same
    // failure mode the write-gate test above guards against.
    expect(screen.getByRole("table", { name: "Version history" })).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });

  it("shows the write form under the pre-cutover bypass, same as any other render-path gate", async () => {
    requiresCapability.mockReturnValue(false);
    signIn([]);

    render(await renderPage({ path: ["homechef", "homechef-api", "db-password"], store: "openbao" }));

    expect(screen.getByRole("tab", { name: "Write" })).toBeInTheDocument();
  });
});
