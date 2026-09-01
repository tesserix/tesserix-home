import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchSecretStores = vi.fn();

vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  fetchSecretStores: (...args: unknown[]) => fetchSecretStores(...args),
}));

// `getCurrentSession` and `requiresCapability` back the render-path gate.
// `hasCapability` itself is NOT mocked, matching `[...path]/page.test.tsx` —
// a passing gate test here is evidence about the real capability decision,
// not a stand-in for it.
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

// Both action modules cross a "use server" boundary into `lib/secrets-api.ts`,
// and this suite never submits the form, so they are stubbed exactly as
// `create-secret-form.test.tsx` stubs them. Nothing here reads the stubs; they
// only keep the import graph off the operator-token store.
vi.mock("../[...path]/actions", () => ({ writeSecretAction: vi.fn() }));
vi.mock("./actions", () => ({ secretExistsAction: vi.fn() }));

import { PlatformApiError } from "@/lib/platform-api-error";
import { SECRETS_UNAVAILABLE_TITLE } from "../page";
import NewSecretPage, { CANNOT_CREATE_MESSAGE } from "./page";

// The page is a server component, exercised the same way every sibling
// surface is: its default export is awaited and rendered directly.

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
  fetchSecretStores.mockReset();
  fetchSecretStores.mockResolvedValue({ enabled: ["openbao", "gcpsm"], preferred: "openbao" });
  getCurrentSession.mockReset();
  getCurrentSession.mockResolvedValue(null);
  requiresCapability.mockReset();
  requiresCapability.mockReturnValue(true);
});

describe("the create surface's render-path gate", () => {
  it("renders the form to an operator holding platform and rotate-credentials", async () => {
    signIn(["platform", "rotate-credentials"]);

    render(await NewSecretPage());

    expect(screen.getByRole("form", { name: "Create secret" })).toBeInTheDocument();
    expect(screen.queryByText(CANNOT_CREATE_MESSAGE)).toBeNull();
  });

  // Both halves are asserted, not just the refusal sentence — a test checking
  // only the sentence would still pass if the form rendered right beside it,
  // which is the failure mode that matters: the API would refuse the write and
  // the operator would have filled in a value for nothing.
  it("renders the refusal, and NO form, to a platform-only operator", async () => {
    signIn(["platform"]);

    render(await NewSecretPage());

    expect(screen.getByText(CANNOT_CREATE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Create secret" })).toBeNull();
  });

  it("does not read the store list at all when the gate refuses", async () => {
    // The refusal comes before the fetch, deliberately: there is nothing to
    // populate and no reason to spend a round trip on an operator who will
    // not see the form.
    signIn(["platform"]);

    render(await NewSecretPage());

    expect(fetchSecretStores).not.toHaveBeenCalled();
  });

  it("renders the form before cutover, when no provider requires capabilities", async () => {
    // `requiresCapability()` is false under `google`, where sessions carry no
    // roles at all — the gate must not lock every operator out on deploy.
    requiresCapability.mockReturnValue(false);
    getCurrentSession.mockResolvedValue(null);

    render(await NewSecretPage());

    expect(screen.getByRole("form", { name: "Create secret" })).toBeInTheDocument();
  });
});

describe("the store-list read", () => {
  beforeEach(() => {
    signIn(["platform", "rotate-credentials"]);
  });

  it("renders the inventory's own 'not configured' copy on a 501, not an error", async () => {
    // A 501 means `SECRETS_API_ORIGIN` is unset — the same calm state the
    // inventory renders, using the same copy, imported rather than restated.
    fetchSecretStores.mockRejectedValue(
      new PlatformApiError("backends: SECRETS_API_ORIGIN is not set", 501),
    );

    render(await NewSecretPage());

    expect(screen.getByText(SECRETS_UNAVAILABLE_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Create secret" })).toBeNull();
  });

  it("keeps the internal 501 message off the page", async () => {
    // `secretsReadError`'s override exists so this string never reaches an
    // operator; asserting its absence is what proves the override ran.
    fetchSecretStores.mockRejectedValue(
      new PlatformApiError("backends: SECRETS_API_ORIGIN is not set", 501),
    );

    render(await NewSecretPage());

    expect(screen.queryByText(/SECRETS_API_ORIGIN is not set/)).toBeNull();
  });

  it("renders the error state on any other rejection, rather than throwing", async () => {
    // Caught, not allowed to reject: an uncaught rejection would hand the
    // route error boundary a page with no header and no way back.
    fetchSecretStores.mockRejectedValue(new PlatformApiError("secrets-api returned 502", 502));

    render(await NewSecretPage());

    expect(screen.getByText("secrets-api returned 502")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Create secret" })).toBeNull();
  });
});

describe("the form's inputs come from the API, not from a literal", () => {
  it("offers only the enabled stores, and preselects the reported default", async () => {
    signIn(["platform", "rotate-credentials"]);
    fetchSecretStores.mockResolvedValue({ enabled: ["gcpsm"], preferred: "gcpsm" });

    render(await NewSecretPage());

    // One enabled store renders as static text naming it, never a select —
    // see `CreateSecretForm`'s own reasoning.
    expect(screen.getByLabelText("Store")).toHaveTextContent("Google Secret Manager");
    expect(screen.queryByText("OpenBao")).toBeNull();
  });
});
