import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

/**
 * `copyAndLogDm`'s one load-bearing decision: WHO decided that
 * `crm_activities.body` should receive text.
 *
 * The answer must be "the server, by re-rendering". Every test below is about
 * that and nothing else, because it is the only control standing between
 * `crm_contacts.biography` and a table `eraseContact` cannot reach — see
 * `crm-outreach.ts`'s header for why that is a compliance defect rather than
 * an untidy row.
 *
 * `crm-outreach.integration.test.ts` proves what lands in the table.
 * THIS file proves what this action ASKS for, which is the half a finished
 * table cannot show: a request carrying `edited: true` alongside the verbatim
 * render leaves no trace of its lie in the row it fails to produce.
 *
 * `renderTemplate` is spied rather than stubbed (`vi.fn(actual)`), the same
 * choice `actions.templates.test.ts` makes: the string this action compares
 * against has to be the one the console's real renderer produces, or the
 * comparison is evidence about a mock.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  assertNoSuppressedContact: vi.fn(),
}));
vi.mock("@/lib/db/crm-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-templates")>()),
  listTemplates: vi.fn(),
  templateContext: vi.fn(),
}));
vi.mock("@/lib/db/crm-outreach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-outreach")>()),
  recordTemplatedDm: vi.fn(),
}));
vi.mock("@/lib/crm-merge-fields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crm-merge-fields")>();
  return { ...actual, renderTemplate: vi.fn(actual.renderTemplate) };
});
// The real `withCrmWrite` and the real `auditedOperation`: a passing test here
// is then evidence about the control this app ships, not about a copy of it.
// Only the two leaf dependencies are mocked, exactly as `actions.test.ts` does.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { assertNoSuppressedContact, SuppressedContactError } from "@/lib/db/crm-repo";
import {
  listTemplates,
  templateContext,
  type TemplateRow,
  type TemplateContext,
} from "@/lib/db/crm-templates";
import { recordTemplatedDm, TemplateUnavailableError } from "@/lib/db/crm-outreach";
import { renderTemplate } from "@/lib/crm-merge-fields";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { copyAndLogDm } from "./actions";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

/** The scraped bio, distinctive enough that finding it anywhere is proof of
 *  where it came from. */
const BIO = "SENTINEL-BIO-8f3c artisan sourdough since 2019";

/** What the server's own render produces for the fixture below. Written out
 *  rather than computed, so a change to the renderer that altered it would
 *  surface here as a failure rather than as a silently agreeing expectation. */
const VERBATIM = `Hi Ada — love what Flour & Ash does. ${BIO}`;

const TEMPLATE: TemplateRow = {
  id: TEMPLATE_ID,
  name: "Cold intro",
  channel: "dm",
  product: null,
  subject: null,
  body: "Hi {{contact.name}} — love what {{org.name}} does. {{contact.biography}}",
  isArchived: false,
  createdBy: "op@tesserix.dev",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CONTEXT: TemplateContext = {
  organisation: { id: ORG_ID, name: "Flour & Ash", location: "Bondi", category: ["bakery"] },
  contacts: [
    {
      id: CONTACT_ID,
      name: "Ada",
      email: "ada@example.com",
      instagramHandle: "@ada",
      biography: BIO,
    },
  ],
};

function signIn(roles: readonly string[] | undefined = ["crm"]) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The `[actor, action, target, occurredAt, metadata]` insert `writeAuditEntry`
 *  issues, read the same way `actions.test.ts` reads it. */
function lastAuditInsert(): { action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { action, target, summary: metadata ? JSON.parse(metadata) : null };
}

/** What `recordTemplatedDm` was asked to persist. */
function recorded(): Parameters<typeof recordTemplatedDm>[0] {
  const call = vi.mocked(recordTemplatedDm).mock.calls.at(-1);
  if (!call) throw new Error("recordTemplatedDm was never called");
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
  vi.mocked(assertNoSuppressedContact).mockResolvedValue(undefined);
  vi.mocked(listTemplates).mockResolvedValue([TEMPLATE]);
  vi.mocked(templateContext).mockResolvedValue(CONTEXT);
  vi.mocked(recordTemplatedDm).mockResolvedValue({
    activityId: "activity-1",
    edited: false,
    contactLabel: "@ada",
    opportunitiesTouched: 1,
    stagesAdvanced: 1,
  });
  signIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("copyAndLogDm — the server decides what is edited", () => {
  it("re-renders on the server and asks for a NULL body when the text is verbatim", async () => {
    const result = await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(result).toEqual({ ok: true });
    // The re-render is not an implementation detail to be tolerated — it is
    // the control. If this action ever stopped calling the renderer, it would
    // have nothing to compare against and could only believe the client.
    expect(renderTemplate).toHaveBeenCalled();
    expect(recorded().bodyIfEdited).toBeNull();
  });

  it("never passes the scraped biography to the write on the verbatim path", async () => {
    // The negative control: the render really did contain the sentinel, so its
    // absence below is a fact about this action rather than about a fixture
    // that quietly stopped populating the bio.
    expect(VERBATIM).toContain(BIO);

    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(JSON.stringify(recorded())).not.toContain(BIO);
  });

  it("ignores a client claiming the verbatim render was edited", async () => {
    // The smuggling attempt, at the boundary it crosses. A hand-crafted
    // request adds `edited: true` and submits our own render unchanged; if the
    // action trusted the flag, `bodyIfEdited` would be the render — biography
    // and all — and it would land in the one table `eraseContact` cannot
    // reach. The flag is not part of the input type, which is why this test
    // has to cast: the type is the first defence and this is the second.
    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
      edited: true,
    } as never);

    expect(recorded().bodyIfEdited).toBeNull();
    expect(JSON.stringify(recorded())).not.toContain(BIO);
  });

  it("keeps the operator's own text when it differs from the render", async () => {
    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: "Hi Ada, saw your Tuesday bake — worth a chat?",
    });

    expect(recorded().bodyIfEdited).toBe("Hi Ada, saw your Tuesday bake — worth a chat?");
  });

  it("treats a one-character edit as the operator's text, not as ours", async () => {
    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: `${VERBATIM}!`,
    });

    // The stated residual: they keep the rest of the render, biography
    // included, and `metadata.edited` is what lets an erasure request find
    // this row without reading every activity in the table.
    expect(recorded().bodyIfEdited).toBe(`${VERBATIM}!`);
  });

  it("compares against a render of the LIVE contact row, not the submitted one", async () => {
    // The bio changed since the preview. The text the operator holds is now
    // ours-as-of-then, which is nobody's current render — so it is treated as
    // theirs and stored. Believing the client here would have stored it while
    // claiming it was our render.
    vi.mocked(templateContext).mockResolvedValue({
      ...CONTEXT,
      contacts: [{ ...CONTEXT.contacts[0], biography: "a different bio entirely" }],
    });

    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(recorded().bodyIfEdited).toBe(VERBATIM);
  });
});

describe("copyAndLogDm — refusals", () => {
  it("does not write when the render has stopped being possible", async () => {
    vi.mocked(templateContext).mockResolvedValue({
      ...CONTEXT,
      contacts: [{ ...CONTEXT.contacts[0], biography: null }],
    });

    const result = await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(result).toEqual({
      ok: false,
      message: "Cannot use this template: no bio recorded for this contact.",
    });
    expect(recordTemplatedDm).not.toHaveBeenCalled();
  });

  it("refuses a suppressed organisation before rendering anything", async () => {
    vi.mocked(assertNoSuppressedContact).mockRejectedValue(new SuppressedContactError(ORG_ID));

    const result = await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(result.ok).toBe(false);
    // Call ORDERING, not the return value: both orderings refuse, and only
    // this assertion can tell "never produced" from "produced and discarded".
    expect(renderTemplate).not.toHaveBeenCalled();
    expect(recordTemplatedDm).not.toHaveBeenCalled();
  });

  it("surfaces the write's own refusal rather than a generic failure", async () => {
    vi.mocked(recordTemplatedDm).mockRejectedValue(
      new TemplateUnavailableError(TEMPLATE_ID, "That template is no longer available."),
    );

    const result = await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(result).toEqual({ ok: false, message: "That template is no longer available." });
  });

  it("refuses an operator without the crm capability, and writes nothing", async () => {
    signIn(["read"]);

    const result = await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(result).toEqual({ ok: false, message: "You don't have permission to edit the CRM." });
    expect(recordTemplatedDm).not.toHaveBeenCalled();
  });
});

describe("copyAndLogDm — the audit row", () => {
  it("names the contact, never the message", async () => {
    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    const audit = lastAuditInsert();
    expect(audit.action).toBe("crm.outreach.dm");
    expect(audit.target).toBe(`@ada (${CONTACT_ID})`);
    expect(audit.target).not.toContain(BIO);
    expect(JSON.stringify(audit.summary)).not.toContain(BIO);
  });

  it("counts the send and whether a human authored it", async () => {
    vi.mocked(recordTemplatedDm).mockResolvedValue({
      activityId: "activity-1",
      edited: true,
      contactLabel: "@ada",
      opportunitiesTouched: 1,
      stagesAdvanced: 1,
    });

    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: "my own words",
    });

    expect(lastAuditInsert().summary).toMatchObject({ logged: 1, edited: 1 });
  });

  it("revalidates the organisation and the queue", async () => {
    await copyAndLogDm({
      organisationId: ORG_ID,
      contactId: CONTACT_ID,
      templateId: TEMPLATE_ID,
      submittedText: VERBATIM,
    });

    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm");
  });
});
