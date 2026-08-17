import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/crm-writes", () => ({
  createOrganisation: vi.fn(),
}));
// Ruling 17: every CRM write goes through the one wrapper — session check,
// capability gate, audit. `withCrmWrite` is mocked directly here (unlike
// `[organisation]/actions.test.ts`, which exercises the real
// `auditedOperation`) because this test's job is narrower: prove
// `createOrganisationAction` calls the wrapper at all, and hands it the
// right `describe`, not re-prove the wrapper's own internals a second time.
vi.mock("@/lib/crm-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm-write")>()),
  withCrmWrite: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { createOrganisation } from "@/lib/db/crm-writes";
import { withCrmWrite } from "@/lib/crm-write";
import { createOrganisationAction } from "./actions";

describe("createOrganisationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goes through withCrmWrite rather than calling the repo directly", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "Newtown Roasters");

    await createOrganisationAction(form);

    expect(withCrmWrite).toHaveBeenCalled();
  });

  it("rejects a blank name before reaching the database", async () => {
    const form = new FormData();
    form.set("name", "   ");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/name/i) });
    expect(createOrganisation).not.toHaveBeenCalled();
    expect(withCrmWrite).not.toHaveBeenCalled();
  });

  it("audits the organisation name, not the raw form", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "Newtown Roasters");

    await createOrganisationAction(form);

    const describe = vi.mocked(withCrmWrite).mock.calls[0][2];
    const description = describe({ organisationId: "org-1" });
    expect(description.action).toBe("crm.organisation.create");
    // AuditSummary is Readonly<Record<string, number>> — counts, never names.
    expect(description.summary).toEqual({ organisations: 1 });
    expect(description.target).toBe("Newtown Roasters (org-1)");
  });

  it("passes optional fields through only when present", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "Bondi Baker");
    form.set("location", "  Bondi Beach  ");
    form.set("contactName", "  Ava  ");
    form.set("product", "mark8ly");

    await createOrganisationAction(form);

    const run = vi.mocked(withCrmWrite).mock.calls[0][1];
    await run({ sub: "sub-1", email: "ava@tesserix.app" });

    expect(createOrganisation).toHaveBeenCalledWith({
      name: "Bondi Baker",
      location: "Bondi Beach",
      websiteUrl: undefined,
      contact: { name: "Ava", email: undefined, instagramHandle: undefined },
      opportunity: { product: "mark8ly", owner: undefined },
    });
  });

  it("returns ok:true and revalidates the organisations list on success", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "Newtown Roasters");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/organisations");
  });

  it("returns the wrapper's failure verbatim without revalidating", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: false, message: "That change was not saved." });
    const form = new FormData();
    form.set("name", "Newtown Roasters");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // The reviewer named this gap explicitly: `product` was validated against
  // the estate, but the rejection path had no test proving it stops before
  // `withCrmWrite` — an invalid form is not an audited event.
  it("rejects a product that is not in the estate before reaching withCrmWrite", async () => {
    const form = new FormData();
    form.set("name", "Newtown Roasters");
    form.set("product", "mark8ley");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({ ok: false, message: `"mark8ley" is not a product in the estate.` });
    expect(createOrganisation).not.toHaveBeenCalled();
    expect(withCrmWrite).not.toHaveBeenCalled();
  });

  // Fix round 1: `crm_organisations.website_url` is rendered back as a
  // clickable `<a href target="_blank">` on the organisation detail page —
  // `type="url"` on the form input is a browser-side hint only, and this
  // server action is directly invocable. A `javascript:` URL stored here
  // becomes a stored XSS payload for the next operator who opens the record.
  it("rejects a javascript: website URL before reaching withCrmWrite", async () => {
    const form = new FormData();
    form.set("name", "Newtown Roasters");
    form.set("websiteUrl", "javascript:alert(1)");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({
      ok: false,
      message: "Website must be a web address starting with http:// or https://.",
    });
    expect(createOrganisation).not.toHaveBeenCalled();
    expect(withCrmWrite).not.toHaveBeenCalled();
  });

  it("accepts a real http(s) website URL", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "Newtown Roasters");
    form.set("websiteUrl", "https://newtownroasters.example");

    const result = await createOrganisationAction(form);

    expect(result).toEqual({ ok: true });
  });

  // Minor fix: the `NO_PRODUCT_VALUE` sentinel ("__none__") is meaningful
  // only to the product `<Select>`. `optionalField` must stay generic, or an
  // organisation genuinely named "__none__" would be rejected as blank and a
  // `location` of "__none__" would be silently dropped.
  it("does not treat the product sentinel as blank for other fields", async () => {
    vi.mocked(withCrmWrite).mockResolvedValue({ ok: true, value: { organisationId: "org-1" } });
    const form = new FormData();
    form.set("name", "__none__");
    form.set("location", "__none__");

    await createOrganisationAction(form);

    const run = vi.mocked(withCrmWrite).mock.calls[0][1];
    await run({ sub: "sub-1", email: "ava@tesserix.app" });

    expect(createOrganisation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "__none__", location: "__none__" }),
    );
  });
});
