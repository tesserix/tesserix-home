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
});
