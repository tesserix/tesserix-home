import { describe, expect, it, vi } from "vitest";

// `writeSecret` lives in `lib/secrets-api.ts` (`server-only`, an operator-
// token read through `pg`). Mocked here for the same reason
// `write-secret-form.test.tsx` mocks this whole module: `writeSecretAction`
// is the boundary under test, not `writeSecret` itself — `secrets-api.test.ts`
// (Task 2) already proves `writeSecret` PUTs correctly on the wire. This is
// the one test file that exercises `writeSecretAction` directly instead of
// mocking it away, so it is also the only place `describeFailure` — in
// particular its 409 branch — gets any coverage at all.
const writeSecret = vi.fn();
vi.mock("@/lib/secrets-api", () => ({
  writeSecret: (...args: unknown[]) => writeSecret(...args),
}));

import { PlatformApiError } from "@/lib/platform-api-error";
import { writeSecretAction } from "./actions";

describe("writeSecretAction", () => {
  it("returns {ok: true, version} on a successful write", async () => {
    writeSecret.mockResolvedValueOnce({ path: "mark8ly/db-password", version: 3, backend: "openbao" });

    const outcome = await writeSecretAction("openbao", "mark8ly/db-password", { PASSWORD: "hunter2" }, 2);

    expect(outcome).toEqual({ ok: true, version: 3 });
  });

  it("maps a 409 PlatformApiError to the reload copy, not the raw status message", async () => {
    writeSecret.mockRejectedValueOnce(
      new PlatformApiError("write secret: secrets-api returned 409", 409),
    );

    const outcome = await writeSecretAction("openbao", "mark8ly/db-password", { PASSWORD: "hunter2" }, 2);

    expect(outcome).toEqual({
      ok: false,
      message: "This secret changed since this page loaded — reload it and try again.",
    });
  });

  it("surfaces a non-409 PlatformApiError's own message", async () => {
    writeSecret.mockRejectedValueOnce(new PlatformApiError("write secret: secrets-api returned 403", 403));

    const outcome = await writeSecretAction("openbao", "mark8ly/db-password", { PASSWORD: "hunter2" }, 2);

    expect(outcome).toEqual({ ok: false, message: "write secret: secrets-api returned 403" });
  });

  it("falls back to a static message for a non-PlatformApiError failure", async () => {
    // The shape `parseWriteResult` throws (a plain `Error`, not a
    // `PlatformApiError`) when the server hands back a malformed write
    // response — see `lib/secrets-api.ts`.
    writeSecret.mockRejectedValueOnce(new Error("secrets: write response .version is not a positive number"));

    const outcome = await writeSecretAction("openbao", "mark8ly/db-password", { PASSWORD: "hunter2" }, 2);

    expect(outcome).toEqual({ ok: false, message: "The value was not saved." });
  });

  it("the failure result carries no error instance and no cause — plain data only", async () => {
    const cause = new PlatformApiError("write secret: secrets-api returned 500", 500, {
      cause: new Error("upstream blew up"),
    });
    writeSecret.mockRejectedValueOnce(cause);

    const outcome = await writeSecretAction("openbao", "mark8ly/db-password", { PASSWORD: "hunter2" }, 2);

    expect(outcome).toEqual({ ok: false, message: "write secret: secrets-api returned 500" });
    expect(Object.keys(outcome)).toEqual(["ok", "message"]);
    expect((outcome as { cause?: unknown }).cause).toBeUndefined();
    // Nothing in the returned object is the thrown error itself, or wraps it.
    expect(outcome).not.toBe(cause);
    for (const value of Object.values(outcome)) {
      expect(value).not.toBeInstanceOf(Error);
    }
  });
});
