import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/operator")>()),
  checkOperatorCapability: vi.fn(),
}));
// Ruling 15/17: goes through the REAL `auditedOperation` (not mocked) —
// only its leaf dependency is, the same way `suppressions/actions.test.ts`
// tests this wrapper's caller. A passing test here is evidence about the
// actual control this app ships, not a copy of it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { withCrmWrite } from "./crm-write";

const description = { action: "crm.test.action", summary: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles: ["read"],
    iat: 0,
    exp: 0,
  } as never);
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
});

describe("withCrmWrite", () => {
  it("gates on read by default, so existing callers are unchanged", async () => {
    await withCrmWrite("crm:org", async () => "ok", () => description);
    expect(checkOperatorCapability).toHaveBeenCalledWith(expect.anything(), "read");
  });

  it("gates on the capability the caller names", async () => {
    await withCrmWrite("crm:org", async () => "ok", () => description, undefined, {
      capability: "hard-delete",
    });
    expect(checkOperatorCapability).toHaveBeenCalledWith(expect.anything(), "hard-delete");
  });

  it("returns the permission message and never runs the operation when the gate fails", async () => {
    vi.mocked(checkOperatorCapability).mockImplementation(() => {
      throw new CapabilityError("hard-delete");
    });
    const run = vi.fn();
    const result = await withCrmWrite("crm:org", run, () => description, undefined, {
      capability: "hard-delete",
    });
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "You don't have permission to edit the CRM." });
  });
});
