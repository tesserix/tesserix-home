import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-templates")>()),
  createTemplate: vi.fn(),
  archiveTemplate: vi.fn(),
}));
// Ruling 15/17: goes through the REAL `auditedOperation`/`withCrmWrite`
// (neither is mocked) — only the two leaf dependencies are, exactly the way
// `suppressions/actions.test.ts` tests the same shared wrapper. A passing test
// here is evidence about the actual control this app ships, not a copy of it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { UnknownMergeFieldError } from "@/lib/crm-merge-fields";
import { archiveTemplate, createTemplate, type TemplateRow } from "@/lib/db/crm-templates";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { archiveTemplateAction, createTemplateAction } from "./actions";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The one write `writeAuditEntry` issues — `[actor, action, target,
 *  occurredAt, metadata]`, per audit-repo.ts. */
function lastAuditInsert(): {
  actor: string;
  action: string;
  target: string | null;
  summary: unknown;
} {
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

const TEMPLATE: TemplateRow = {
  id: "t1",
  name: "Bondi cafés — first touch",
  channel: "dm",
  product: null,
  subject: null,
  body: "Hi {{contact.name}}",
  isArchived: false,
  createdBy: "ava@tesserix.app",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("createTemplateAction", () => {
  it("writes the template, audits crm.template.create under the actor's sub, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);

    const result = await createTemplateAction({
      name: "Bondi cafés — first touch",
      channel: "dm",
      body: "Hi {{contact.name}}",
    });

    expect(result).toEqual({ ok: true });
    expect(createTemplate).toHaveBeenCalledWith({
      name: "Bondi cafés — first touch",
      channel: "dm",
      product: null,
      subject: null,
      body: "Hi {{contact.name}}",
      // `created_by` carries the operator's EMAIL — it is rendered beside each
      // template in the list, where a Zitadel `sub` would be unreadable. The
      // audit actor below is the `sub`. The two must not be swapped.
      actor: "ava@tesserix.app",
    });
    const audit = lastAuditInsert();
    expect(audit.actor).toBe("sub-1");
    expect(audit.action).toBe("crm.template.create");
    expect(audit.summary).toEqual({ created: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/templates");
  });

  // Ruling 20: `console_audit_log.target` holds the readable fact. The row's
  // uuid does not even exist at the point the wrapper is entered, and "which
  // template was authored?" is unanswerable from one afterwards.
  it("audits the template's name as the target", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);

    await createTemplateAction({ name: "  Bondi  ", channel: "dm", body: "Hi" });

    // Trimmed in the audit row too, not just in the write — an audit target
    // with stray whitespace does not match the name the list renders.
    expect(lastAuditInsert().target).toBe("Bondi");
  });

  // A server action is a network-reachable endpoint; the form's `.trim()` is
  // not the boundary that matters.
  it("trims the name, body, product and subject server-side", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);

    await createTemplateAction({
      name: "  Bondi cafés  ",
      channel: "email",
      product: "  mark8ly  ",
      subject: "  A note about {{org.name}}  ",
      body: "  Hi {{contact.name}}  ",
    });

    expect(createTemplate).toHaveBeenCalledWith({
      name: "Bondi cafés",
      channel: "email",
      product: "mark8ly",
      subject: "A note about {{org.name}}",
      body: "Hi {{contact.name}}",
      actor: "ava@tesserix.app",
    });
  });

  // Empty means ANY product, per 0043's header — not "unknown". A
  // whitespace-only product must become NULL rather than a `'  '` nobody can
  // ever match a lead against.
  it("turns a blank product into null rather than storing whitespace", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);

    await createTemplateAction({ name: "Bondi", channel: "dm", product: "   ", body: "Hi" });

    expect(vi.mocked(createTemplate).mock.calls[0][0].product).toBeNull();
  });

  /**
   * THE VALIDATION THIS SURFACE EXISTS TO NOT SKIP.
   *
   * `crm_templates.name` is `NOT NULL`, and `''` satisfies `NOT NULL` — so
   * without this check Postgres accepts a nameless template and it appears in
   * every composer's picker as a blank line the operator cannot identify. The
   * assertion is not merely "the action returned an error": it is that NOTHING
   * happened — no session fetch, no repository call, and no `tesserixQuery`,
   * which means no audit row either. An action that refused only after opening
   * a transaction would still pass a weaker version of this test.
   */
  it("refuses an empty name without touching the session, the repository or the database", async () => {
    const result = await createTemplateAction({ name: "   ", channel: "dm", body: "Hi" });

    expect(result).toEqual({ ok: false, message: "Give the template a name." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(createTemplate).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // The same property for the body, and it matters more: a template with a
  // name and no body renders as an empty message the composer will happily
  // put on an operator's clipboard.
  it("refuses an empty body without touching the session, the repository or the database", async () => {
    const result = await createTemplateAction({ name: "Bondi", channel: "dm", body: "  \n  " });

    expect(result).toEqual({ ok: false, message: "Write the message body." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(createTemplate).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * The unknown-token path, end to end.
   *
   * The message must NAME the bad token: "that change was not saved" gives the
   * author of a typo nothing to act on, and they are the only person who can
   * fix it. Asserted against `new UnknownMergeFieldError(...).message` rather
   * than a string literal, because `previewTemplate` composes its own copy the
   * identical way — a literal here would let the two drift apart and still go
   * green, which is exactly the divergence the shared error exists to prevent.
   */
  it("surfaces the unknown merge field by name rather than the generic refusal", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockRejectedValue(
      new UnknownMergeFieldError(["contact.followers"]),
    );

    const result = await createTemplateAction({
      name: "Bondi",
      channel: "dm",
      body: "Hi {{contact.followers}}",
    });

    expect(result).toEqual({
      ok: false,
      message: new UnknownMergeFieldError(["contact.followers"]).message,
    });
    // Guards the guard: a message that had been flattened to the generic one
    // would still be a string, and would still be `ok: false`.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("{{contact.followers}}");
      expect(result.message).not.toBe("That change was not saved.");
    }
  });

  // Guards the allowlist: `mapUnknownMergeField` must be an allowlist of ONE,
  // not "any Error is safe to show". A raw pg message — a constraint name, a
  // relation name — must never reach the operator verbatim.
  it("maps any other database error to the generic message, not the raw text", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockRejectedValue(
      new Error(
        'new row for relation "crm_templates" violates check constraint "crm_template_subject_is_email_only"',
      ),
    );

    const result = await createTemplateAction({
      name: "Bondi",
      channel: "dm",
      subject: "not allowed on a DM",
      body: "Hi",
    });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
  });

  // `createTemplate`'s header: a subject on a DM is PASSED THROUGH and refused
  // by the CHECK, never quietly nulled. Silently dropping the operator's words
  // is the failure 0043's constraint exists to prevent, and the action must
  // not reintroduce it one layer up.
  it("passes a DM's subject through to be refused rather than silently dropping it", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);

    await createTemplateAction({
      name: "Bondi",
      channel: "dm",
      subject: "A subject on a DM",
      body: "Hi",
    });

    expect(vi.mocked(createTemplate).mock.calls[0][0].subject).toBe("A subject on a DM");
  });

  it("refuses without the crm capability", async () => {
    signIn(undefined);

    const result = await createTemplateAction({ name: "Bondi", channel: "dm", body: "Hi" });

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(createTemplate).not.toHaveBeenCalled();
  });

  // Same property `suppressions/actions.test.ts` pins: a failed audit write
  // must discard the result rather than report success.
  it("discards the result when the audit write fails, and does not report success", async () => {
    signIn(["crm"]);
    vi.mocked(createTemplate).mockResolvedValue(TEMPLATE);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await createTemplateAction({ name: "Bondi", channel: "dm", body: "Hi" });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("archiveTemplateAction", () => {
  it("archives the template, audits the real row count, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(archiveTemplate).mockResolvedValue([{ ...TEMPLATE, isArchived: true }]);

    const result = await archiveTemplateAction("t1");

    expect(result).toEqual({ ok: true });
    expect(archiveTemplate).toHaveBeenCalledWith("t1");
    const audit = lastAuditInsert();
    expect(audit.actor).toBe("sub-1");
    expect(audit.action).toBe("crm.template.archive");
    expect(audit.summary).toEqual({ archived: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/templates");
  });

  // Ruling 20: the name, not the uuid it was looked up by. Once the row stops
  // appearing in the list, "which template did we retire?" is unanswerable
  // from a uuid.
  it("audits the template's name as the target, not the uuid it was looked up by", async () => {
    signIn(["crm"]);
    vi.mocked(archiveTemplate).mockResolvedValue([{ ...TEMPLATE, isArchived: true }]);

    await archiveTemplateAction("t1");

    const audit = lastAuditInsert();
    expect(audit.target).toBe("Bondi cafés — first touch");
    expect(audit.target).not.toBe("t1");
  });

  // `archiveTemplate`'s `WHERE id = $1 AND NOT is_archived` matches nothing on
  // a second archive or an unknown id. The audit row must say so rather than
  // claim a retirement that did not happen.
  it("audits archived: 0 when nothing matched, rather than assuming success", async () => {
    signIn(["crm"]);
    vi.mocked(archiveTemplate).mockResolvedValue([]);

    const result = await archiveTemplateAction("missing");

    expect(result).toEqual({ ok: true });
    const audit = lastAuditInsert();
    expect(audit.summary).toEqual({ archived: 0 });
    // No row means no name to report — the uuid is the only identifier this
    // call ever had, so it is the only honest fallback.
    expect(audit.target).toBe("missing");
  });

  it("refuses without the crm capability, before the repository is touched, and audits the refusal", async () => {
    // #409: the capability check runs inside `auditedOperation`, so a refusal
    // writes a `capability.refused` row instead of writing nothing.
    signIn(undefined);

    const result = await archiveTemplateAction("t1");

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(archiveTemplate).not.toHaveBeenCalled();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });

  it("with no database configured, refuses and writes nothing", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(["crm"]);

    const result = await archiveTemplateAction("t1");

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(archiveTemplate).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("discards the result when the audit write fails, and does not report success", async () => {
    signIn(["crm"]);
    vi.mocked(archiveTemplate).mockResolvedValue([{ ...TEMPLATE, isArchived: true }]);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await archiveTemplateAction("t1");

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
