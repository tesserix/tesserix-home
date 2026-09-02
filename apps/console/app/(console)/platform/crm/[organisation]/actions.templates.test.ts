import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `previewTemplate`'s three guarantees, in the order it applies them.
 *
 * The one that needs a test rather than a reading is the FIRST: a suppressed
 * organisation must be refused BEFORE `renderTemplate` runs, not after. Both
 * orderings return the same union to the caller, so no assertion on the
 * return value can tell them apart — which is exactly why the assertion here
 * is on CALL ORDERING (`expect(renderTemplate).not.toHaveBeenCalled()`). A
 * message produced and then discarded has still been produced, for someone
 * who asked us to stop.
 *
 * `renderTemplate` is therefore SPIED, not stubbed: `vi.fn(actual)` keeps the
 * real all-or-nothing renderer in the path, so the missing-field tests below
 * are evidence about the renderer this console ships and not about a mock
 * that agrees with it today.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/operator")>()),
  checkOperatorCapabilityLive: vi.fn(),
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
vi.mock("@/lib/crm-merge-fields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crm-merge-fields")>();
  return { ...actual, renderTemplate: vi.fn(actual.renderTemplate) };
});
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { assertNoSuppressedContact, SuppressedContactError } from "@/lib/db/crm-repo";
import {
  listTemplates,
  templateContext,
  type TemplateRow,
  type TemplateContext,
} from "@/lib/db/crm-templates";
import { renderTemplate } from "@/lib/crm-merge-fields";
import { previewTemplate } from "./actions";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

/** A distinctive string, so a test that claims the bio never left the server
 *  is checking for something no other fixture could supply. */
const BIO = "SENTINEL-BIO-4a1c bakes sourdough at dawn";

function template(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
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
    ...overrides,
  };
}

function context(overrides: { biography?: string | null } = {}): TemplateContext {
  return {
    organisation: {
      id: ORG_ID,
      name: "Loafers",
      location: "Bondi",
      category: ["Bakery"],
    },
    contacts: [
      {
        id: CONTACT_ID,
        name: "Ada",
        email: "ada@loafers.example",
        instagramHandle: "loafers",
        biography: "biography" in overrides ? (overrides.biography ?? null) : BIO,
      },
    ],
  };
}

const INPUT = { organisationId: ORG_ID, contactId: CONTACT_ID, templateId: TEMPLATE_ID };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1",
    email: "op@tesserix.dev",
  } as Awaited<ReturnType<typeof getCurrentSession>>);
  vi.mocked(checkOperatorCapabilityLive).mockResolvedValue(undefined);
  vi.mocked(assertNoSuppressedContact).mockResolvedValue(undefined);
  vi.mocked(listTemplates).mockResolvedValue([template()]);
  vi.mocked(templateContext).mockResolvedValue(context());
});

describe("previewTemplate refuses a suppressed lead before anything is rendered", () => {
  beforeEach(() => {
    vi.mocked(assertNoSuppressedContact).mockRejectedValue(new SuppressedContactError(ORG_ID));
  });

  it("returns reason 'suppressed'", async () => {
    const result = await previewTemplate(INPUT);

    expect(result).toEqual({
      ok: false,
      reason: "suppressed",
      message: expect.stringContaining("do-not-contact list"),
    });
  });

  // THE CONSTRAINT. Not "the text was withheld" — "the text was never made".
  it("never calls renderTemplate", async () => {
    await previewTemplate(INPUT);

    expect(renderTemplate).not.toHaveBeenCalled();
  });

  // The same claim from the other side: the biography is not even read, so
  // there is nothing in this process for a log line or an error report to
  // pick up.
  it("never reads the lead's merge values", async () => {
    await previewTemplate(INPUT);

    expect(templateContext).not.toHaveBeenCalled();
  });

  it("checks the suppression list for the organisation it was asked about", async () => {
    await previewTemplate(INPUT);

    expect(assertNoSuppressedContact).toHaveBeenCalledWith(ORG_ID, expect.anything());
  });
});

describe("previewTemplate renders a complete lead", () => {
  it("substitutes every placeholder", async () => {
    const result = await previewTemplate(INPUT);

    expect(result).toEqual({
      ok: true,
      text: `Hi Ada — love what Loafers does. ${BIO}`,
    });
  });

  it("carries a rendered subject for an email template", async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      template({
        channel: "email",
        subject: "A note for {{org.name}}",
        body: "Hi {{contact.name}}.",
      }),
    ]);

    const result = await previewTemplate(INPUT);

    expect(result).toEqual({
      ok: true,
      text: "Hi Ada.",
      subject: "A note for Loafers",
    });
  });
});

describe("previewTemplate refuses rather than half-render", () => {
  it("names the missing field and returns no text at all", async () => {
    vi.mocked(templateContext).mockResolvedValue(context({ biography: null }));

    const result = await previewTemplate(INPUT);

    expect(result).toEqual({
      ok: false,
      reason: "missing-fields",
      missing: ["contact.biography"],
      message: "Cannot use this template: no bio recorded for this contact.",
    });
    // The property is absent, not empty: a caller cannot seed a textarea with
    // a field that is not there.
    expect("text" in result).toBe(false);
  });

  it("treats a whitespace-only bio as missing", async () => {
    vi.mocked(templateContext).mockResolvedValue(context({ biography: "   " }));

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({ ok: false, reason: "missing-fields" });
  });

  it("says 'this organisation' when the gap is on the organisation", async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      template({ body: "We work with {{org.location}} bakeries." }),
    ]);
    vi.mocked(templateContext).mockResolvedValue({
      ...context(),
      organisation: { ...context().organisation, location: null },
    });

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({
      reason: "missing-fields",
      message: "Cannot use this template: no location recorded for this organisation.",
    });
  });

  it("reports an unknown token as an authoring bug, not as missing data", async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      template({ body: "Hi {{contact.followers}}." }),
    ]);

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({
      ok: false,
      reason: "unknown-fields",
      unknown: ["contact.followers"],
      message: expect.stringContaining("{{contact.followers}}"),
    });
    expect("text" in result).toBe(false);
  });
});

describe("previewTemplate refuses what it cannot resolve", () => {
  it("reports an unknown or archived template as not-found", async () => {
    vi.mocked(listTemplates).mockResolvedValue([]);

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it("reports a missing organisation as not-found", async () => {
    vi.mocked(templateContext).mockResolvedValue(null);

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });

  // `templateContext` excludes `erased_at IS NOT NULL`, so an erased contact
  // is absent from the list rather than present under the literal name
  // `'[erased]'` that `eraseContact` writes. Without this branch the template
  // would render "Hi [erased]".
  it("reports a contact that is no longer in the context as erased", async () => {
    vi.mocked(templateContext).mockResolvedValue({ ...context(), contacts: [] });

    const result = await previewTemplate(INPUT);

    expect(result).toMatchObject({ ok: false, reason: "erased" });
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it("does not resolve a contact belonging to another organisation", async () => {
    const result = await previewTemplate({ ...INPUT, contactId: "not-in-this-org" });

    expect(result).toMatchObject({ ok: false, reason: "erased" });
  });
});

describe("previewTemplate gates on the crm capability", () => {
  beforeEach(() => {
    vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(new CapabilityError("crm"));
  });

  it("refuses without saying whether the lead exists", async () => {
    const result = await previewTemplate(INPUT);

    expect(result).toEqual({
      ok: false,
      reason: "not-found",
      message: "That template preview is not available.",
    });
  });

  // T-LDQ-02: `biography` is the only scrape-derived field the console
  // returns anywhere, and this is the gate on it. The assertion is that the
  // read never happens, so no branch of the union can carry it.
  it("returns no biography in any branch", async () => {
    const result = await previewTemplate(INPUT);

    expect(templateContext).not.toHaveBeenCalled();
    expect(renderTemplate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(BIO);
  });

  it("checks the live gate, not the cookie snapshot", async () => {
    await previewTemplate(INPUT);

    expect(checkOperatorCapabilityLive).toHaveBeenCalledWith(expect.anything(), "crm");
  });
});
