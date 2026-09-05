import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
// The two leaf calls, and nothing else. `checkOperatorCapabilityLive` runs for
// real against the mocked session, so a passing row here is evidence about the
// gate this console actually ships rather than a copy of it — the same
// arrangement `crm/suppressions/actions.test.ts` uses.
vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  saveEmailTemplate: vi.fn(),
  testSendEmailTemplate: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { saveEmailTemplate, testSendEmailTemplate } from "@/lib/platform-api";
import { saveEmailTemplateAction, testSendEmailTemplateAction } from "./actions";

const ID = "mark8ly:orderdoc_invoice";

const VALID = {
  subject: "Order {{.OrderNumber}}",
  html_body: "<p>{{.OrderNumber}}</p>",
  text_body: "{{.OrderNumber}}",
  variables: [{ name: "OrderNumber", type: "string", required: true }],
  status: "published" as const,
};

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** As `unwrapEnvelope` builds a refusal: code carried structurally. */
function refusal(code: string, status: number, message = "refused") {
  return Object.assign(new Error(message), { status, code });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  signIn(["platform", "mass-send"]);
  vi.mocked(saveEmailTemplate).mockResolvedValue({} as never);
  vi.mocked(testSendEmailTemplate).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saveEmailTemplateAction", () => {
  it("saves and revalidates both the list and the editor", async () => {
    // Both: the list's Sending-now/Stored-here columns and the editor's own
    // header change on a save, and a stale list would show a draft as
    // published until something else invalidated it.
    await expect(saveEmailTemplateAction(ID, VALID)).resolves.toEqual({ ok: true });
    expect(saveEmailTemplate).toHaveBeenCalledWith(ID, VALID);
    expect(vi.mocked(revalidatePath).mock.calls.map(([path]) => path)).toEqual([
      "/mark8ly/email-templates",
      `/mark8ly/email-templates/${ID}`,
    ]);
  });

  it("refuses an operator without `platform`, and writes nothing", async () => {
    signIn(["crm"]);
    await expect(saveEmailTemplateAction(ID, VALID)).resolves.toEqual({
      ok: false,
      message: "You don't have permission to work with mark8ly's email templates.",
    });
    expect(saveEmailTemplate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not accept `mass-send` in place of `platform`", async () => {
    // The two are not interchangeable in either direction. An operator who may
    // send has not thereby been granted the surface.
    signIn(["mass-send"]);
    await expect(saveEmailTemplateAction(ID, VALID)).resolves.toMatchObject({ ok: false });
    expect(saveEmailTemplate).not.toHaveBeenCalled();
  });

  it("refuses a status that is neither draft nor published", async () => {
    await expect(
      saveEmailTemplateAction(ID, { ...VALID, status: "live" as never }),
    ).resolves.toMatchObject({ ok: false });
    expect(saveEmailTemplate).not.toHaveBeenCalled();
  });

  it("refuses a template with no body at all", async () => {
    // mark8ly would accept it — an empty template parses fine — so the refusal
    // has to be here or the console saves a blank email.
    await expect(
      saveEmailTemplateAction(ID, { ...VALID, html_body: "  ", text_body: "" }),
    ).resolves.toMatchObject({ ok: false });
    expect(saveEmailTemplate).not.toHaveBeenCalled();
  });

  it("accepts a plain-text-only template", async () => {
    // The negative control for the row above: one body is enough, and a check
    // that demanded both would refuse a legitimate save.
    await expect(
      saveEmailTemplateAction(ID, { ...VALID, html_body: "" }),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses a template larger than the API will read", async () => {
    await expect(
      saveEmailTemplateAction(ID, { ...VALID, html_body: "x".repeat((1 << 20) + 1) }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/one megabyte/) });
    expect(saveEmailTemplate).not.toHaveBeenCalled();
  });

  it("maps an upstream refusal to a save-specific sentence", async () => {
    vi.mocked(saveEmailTemplate).mockRejectedValue(refusal("VALIDATION_FAILED", 422));
    const result = await saveEmailTemplateAction(ID, VALID);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toMatch(/unbalanced \{\{ \}\}/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never leaks the upstream error text", async () => {
    vi.mocked(saveEmailTemplate).mockRejectedValue(
      refusal("SERVICE_UNAVAILABLE", 503, "dial tcp 10.4.0.7:8080: i/o timeout"),
    );
    const result = await saveEmailTemplateAction(ID, VALID);
    expect(result.ok ? "" : result.message).not.toMatch(/10\.4\.0\.7/);
  });
});

describe("testSendEmailTemplateAction", () => {
  it("sends when the operator holds both capabilities", async () => {
    await expect(
      testSendEmailTemplateAction(ID, " ops@tesserix.app "),
    ).resolves.toEqual({ ok: true });
    expect(testSendEmailTemplate).toHaveBeenCalledWith(ID, "ops@tesserix.app");
  });

  it("refuses an operator who may edit but not send", async () => {
    // THE SPLIT THIS SURFACE EXISTS TO KEEP. Authoring a template is not
    // sending one, so `platform` alone does not reach this verb.
    signIn(["platform"]);
    const result = await testSendEmailTemplateAction(ID, "ops@tesserix.app");
    expect(result).toEqual({
      ok: false,
      message:
        "You don't have permission to send email. Editing a template and sending one are separate permissions.",
    });
    expect(testSendEmailTemplate).not.toHaveBeenCalled();
  });

  it("tells an operator who holds neither which refusal they hit", async () => {
    // The surface refusal, not the send one: telling someone who cannot reach
    // this page at all that they merely lack a send permission is wrong.
    signIn([]);
    await expect(testSendEmailTemplateAction(ID, "ops@tesserix.app")).resolves.toEqual({
      ok: false,
      message: "You don't have permission to work with mark8ly's email templates.",
    });
  });

  it("refuses an empty or obviously non-address recipient", async () => {
    await expect(testSendEmailTemplateAction(ID, "   ")).resolves.toMatchObject({ ok: false });
    await expect(testSendEmailTemplateAction(ID, "ops")).resolves.toMatchObject({ ok: false });
    expect(testSendEmailTemplate).not.toHaveBeenCalled();
  });

  it("revalidates nothing, because a test send stores nothing", async () => {
    await testSendEmailTemplateAction(ID, "ops@tesserix.app");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps a provider rejection to a send-specific sentence", async () => {
    vi.mocked(testSendEmailTemplate).mockRejectedValue(refusal("EXTERNAL_SERVICE_ERROR", 503));
    const result = await testSendEmailTemplateAction(ID, "ops@tesserix.app");
    expect(result.ok ? "" : result.message).toMatch(/No message was delivered/);
  });
});
