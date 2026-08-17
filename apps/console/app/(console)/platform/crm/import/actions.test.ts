import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
}));
// Ruling 15/17: `commitImportAction` goes through the REAL
// `auditedOperation`/`withCrmWrite` (neither mocked) — only the two leaf
// dependencies are, the same way `suppressions/actions.test.ts` tests the
// shared wrapper. `previewImportAction` does not use `withCrmWrite` at all
// (see actions.ts) so it never touches `tesserixQuery`.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { previewImport, commitImport } from "@/lib/db/crm-repo";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { previewImportAction, commitImportAction } from "./actions";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

function lastAuditInsert(): { actor: string; action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [actor, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { actor, action, target, summary: metadata ? JSON.parse(metadata) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const PREVIEW = { toCreate: 1, matchedExisting: 0, skippedSuppressed: 0, malformed: 0 };
const COMMIT_RESULT = {
  importId: "imp1",
  created: 1,
  matchedExisting: 0,
  skippedSuppressed: 0,
  malformed: 0,
};

describe("previewImportAction", () => {
  it("previews under console entry and returns the counts", async () => {
    signIn(["read"]);
    vi.mocked(previewImport).mockResolvedValue(PREVIEW);

    const result = await previewImportAction([{ email: "ava@example.com" }]);

    expect(result).toEqual({ ok: true, preview: PREVIEW });
    expect(previewImport).toHaveBeenCalledWith([{ email: "ava@example.com" }]);
  });

  it("refuses without console entry", async () => {
    signIn(undefined);

    const result = await previewImportAction([{ email: "ava@example.com" }]);

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(previewImport).not.toHaveBeenCalled();
  });

  // Preview writes nothing, so it does not go through `withCrmWrite` /
  // `auditedOperation` — no audit row, no tesserixQuery call at all, for a
  // dry run an operator can trigger repeatedly while adjusting a CSV.
  it("never touches tesserixQuery — a preview is not an audited write", async () => {
    signIn(["read"]);
    vi.mocked(previewImport).mockResolvedValue(PREVIEW);

    await previewImportAction([{ email: "ava@example.com" }]);

    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("maps a database error to a generic message, not the raw text", async () => {
    signIn(["read"]);
    vi.mocked(previewImport).mockRejectedValue(new Error("connection terminated"));

    const result = await previewImportAction([{ email: "ava@example.com" }]);

    expect(result).toEqual({ ok: false, message: "Could not preview this import." });
  });
});

describe("commitImportAction", () => {
  it("commits, audits crm.import under the actor's sub, and revalidates", async () => {
    signIn(["read"]);
    vi.mocked(commitImport).mockResolvedValue(COMMIT_RESULT);

    const result = await commitImportAction([{ email: "ava@example.com" }], "leads.csv");

    expect(result).toEqual({ ok: true, result: COMMIT_RESULT });
    expect(commitImport).toHaveBeenCalledWith(
      [{ email: "ava@example.com" }],
      "ava@tesserix.app",
      "leads.csv",
    );
    const audit = lastAuditInsert();
    expect(audit.actor).toBe("sub-1");
    expect(audit.action).toBe("crm.import");
    expect(audit.summary).toEqual({ created: 1, matched: 0, skipped: 0, malformed: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/import");
  });

  it("refuses without console entry, and never calls commitImport", async () => {
    signIn(undefined);

    const result = await commitImportAction([{ email: "ava@example.com" }]);

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(commitImport).not.toHaveBeenCalled();
  });

  it("discards the result when the audit write fails, and does not report success", async () => {
    signIn(["read"]);
    vi.mocked(commitImport).mockResolvedValue(COMMIT_RESULT);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await commitImportAction([{ email: "ava@example.com" }]);

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
