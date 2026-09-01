import { describe, expect, it, vi } from "vitest";

// `fetchSecretDetail` lives in `lib/secrets-api.ts` (`server-only`, an
// operator-token read through `pg`). Mocked here for the same reason
// `[...path]/actions.test.ts` mocks `writeSecret` from the same module:
// `secretExistsAction` is the boundary under test, not `fetchSecretDetail`
// itself.
const fetchSecretDetail = vi.fn();
vi.mock("@/lib/secrets-api", () => ({
  fetchSecretDetail: (...args: unknown[]) => fetchSecretDetail(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import { secretExistsAction } from "./actions";

describe("secretExistsAction", () => {
  it("returns {ok: true, exists: true} when fetchSecretDetail resolves", async () => {
    fetchSecretDetail.mockResolvedValueOnce({
      path: "mark8ly/db-password",
      backend: "openbao",
      version: 1,
      data: {},
    });

    const outcome = await secretExistsAction("openbao", "mark8ly/db-password");

    expect(outcome).toEqual({ ok: true, exists: true });
  });

  it("returns {ok: true, exists: false} on a 404 PlatformApiError", async () => {
    fetchSecretDetail.mockRejectedValueOnce(
      new PlatformApiError("secret detail: secrets-api returned 404", 404),
    );

    const outcome = await secretExistsAction("openbao", "mark8ly/new-secret");

    expect(outcome).toEqual({ ok: true, exists: false });
  });

  it("returns {ok: false} on a non-404 PlatformApiError, never {exists: false}", async () => {
    fetchSecretDetail.mockRejectedValueOnce(
      new PlatformApiError("secret detail: secrets-api returned 500", 500),
    );

    const outcome = await secretExistsAction("openbao", "mark8ly/db-password");

    expect(outcome).toEqual({ ok: false, message: "secret detail: secrets-api returned 500" });
    expect(outcome).not.toEqual(expect.objectContaining({ exists: false }));
  });

  it("returns {ok: false} on a non-PlatformApiError rejection", async () => {
    fetchSecretDetail.mockRejectedValueOnce(new Error("network blew up"));

    const outcome = await secretExistsAction("openbao", "mark8ly/db-password");

    expect(outcome).toEqual({
      ok: false,
      message: "Could not check whether this path is already in use.",
    });
  });
});
