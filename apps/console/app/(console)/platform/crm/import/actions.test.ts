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
import { MAX_IMPORT_ROWS, type ImportRow } from "@/lib/crm";
import { previewImportAction, commitImportAction } from "./actions";

function manyRows(count: number): ImportRow[] {
  return Array.from({ length: count }, (_, i) => ({ email: `row${i}@example.com` }));
}

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

const PREVIEW = { toCreate: 1, matchedExisting: 0, skippedSuppressed: 0, malformed: 0, matchedRows: [] };
const COMMIT_RESULT = {
  importId: "imp1",
  created: 1,
  matchedExisting: 0,
  skippedSuppressed: 0,
  malformed: 0,
  matchedRows: [],
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

  // An unbounded file holds the pool's one connection for 2×N round trips —
  // refused before the session or the database is touched at all.
  it("refuses a file over MAX_IMPORT_ROWS, before touching the session or the database", async () => {
    const result = await previewImportAction(manyRows(MAX_IMPORT_ROWS + 1));

    expect(result.ok).toBe(false);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("accepts a file at exactly MAX_IMPORT_ROWS", async () => {
    signIn(["read"]);
    vi.mocked(previewImport).mockResolvedValue(PREVIEW);

    const result = await previewImportAction(manyRows(MAX_IMPORT_ROWS));

    expect(result.ok).toBe(true);
    expect(previewImport).toHaveBeenCalledTimes(1);
  });
});

describe("commitImportAction", () => {
  it("commits, audits crm.import under the actor's sub, and revalidates", async () => {
    signIn(["read"]);
    vi.mocked(commitImport).mockResolvedValue(COMMIT_RESULT);

    const result = await commitImportAction([{ email: "ava@example.com" }], "leads.csv");

    expect(result).toEqual({ ok: true, result: COMMIT_RESULT });
    // 1 row, no explicit totalRows: defaults to rows.length.
    expect(commitImport).toHaveBeenCalledWith(
      [{ email: "ava@example.com" }],
      "ava@tesserix.app",
      "leads.csv",
      1,
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

  it("refuses a file over MAX_IMPORT_ROWS, before touching the session or the database", async () => {
    const result = await commitImportAction(manyRows(MAX_IMPORT_ROWS + 1));

    expect(result.ok).toBe(false);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(commitImport).not.toHaveBeenCalled();
  });

  // Minor: an operator-supplied filename is untrusted input reaching a
  // network-reachable action, same as any CSV cell — bounded before it
  // becomes the audit target or crm_imports.filename.
  it("trims and truncates the filename before it reaches commitImport or the audit target", async () => {
    signIn(["read"]);
    vi.mocked(commitImport).mockResolvedValue(COMMIT_RESULT);
    const long = "  " + "a".repeat(400) + ".csv  ";

    await commitImportAction([{ email: "ava@example.com" }], long);

    const [, , boundedFilename] = vi.mocked(commitImport).mock.calls[0];
    expect(boundedFilename).toHaveLength(255);
    expect(boundedFilename).not.toMatch(/^\s|\s$/);
    const audit = lastAuditInsert();
    expect(audit.target).toBe(boundedFilename);
  });

  // Important 3 / Minor: the caller (import-view.tsx) knows the FULL file
  // size, including rows client-side parsing already dropped as malformed —
  // forwarded through so crm_imports.row_count reflects the whole file, not
  // just the parsed survivors.
  it("forwards an explicit totalRows to commitImport, not just rows.length", async () => {
    signIn(["read"]);
    vi.mocked(commitImport).mockResolvedValue(COMMIT_RESULT);

    await commitImportAction([{ email: "ava@example.com" }], "leads.csv", 5);

    expect(commitImport).toHaveBeenCalledWith(
      [{ email: "ava@example.com" }],
      "ava@tesserix.app",
      "leads.csv",
      5,
    );
  });
});
