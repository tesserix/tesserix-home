import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", () => ({ checkOperatorCapabilityLive: vi.fn() }));
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: vi.fn(() => "https://api.test"),
  platformRequestWithMeta: vi.fn(),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { createTool, deleteGroup, deleteTool, updateTool } from "./tools-write";

afterEach(() => vi.resetAllMocks());

function signedIn() {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1", email: "op@t.test", roles: ["platform"],
  } as never);
  vi.mocked(checkOperatorCapabilityLive).mockResolvedValue(undefined as never);
}

const TOOL = {
  name: "Tempo", subdomain: "tempo", purpose: "Traces.",
  note: null, groupKey: "observability",
};

describe("the tools write seam", () => {
  it("creates a tool and reports success", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    const result = await createTool(TOOL);

    expect(result).toEqual({ ok: true });
    const [, path, init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    expect(path).toBe("/v1/platform/tools");
    expect(init?.method).toBe("POST");
  });

  it("refuses without the capability, and never calls the API", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({ sub: "op-2", roles: ["crm"] } as never);
    // The live gate is async now (tesserix-home#285): a revoked capability is
    // discovered by reading the store, so the refusal arrives as a rejected
    // promise rather than a synchronous throw.
    vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(
      new CapabilityError("platform"),
    );

    const result = await createTool(TOOL);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    // The API is the real boundary and would refuse anyway. This asserts the
    // console does not send a request it knows will be refused.
    expect(platformRequestWithMeta).not.toHaveBeenCalled();
  });

  it("turns a 422 into a field error carrying the API's own message", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError(
        "tools: VALIDATION_ERROR — a subdomain must be a single DNS label — lower-case letters, digits and hyphens",
        422,
      ),
    );

    const result = await createTool({ ...TOOL, subdomain: "https://grafana.example" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The API's sentence survives intact, INCLUDING its own em-dash. Stripping
    // the label and the SCREAMING_SNAKE code must not eat the message.
    expect(result.message).toBe(
      "a subdomain must be a single DNS label — lower-case letters, digits and hyphens",
    );
    expect(result.field).toBe("subdomain");
  });

  it("turns a 409 into a duplicate-subdomain message", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: CONFLICT — a tool with this subdomain already exists", 409),
    );

    const result = await createTool({ ...TOOL, subdomain: "auth" });

    expect(result).toEqual({
      ok: false,
      message: "A tool with this subdomain already exists.",
      field: "subdomain",
    });
  });

  it("turns a 404 into something that tells the operator to reload", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: NOT_FOUND — no tool with this id", 404),
    );

    const result = await updateTool("missing-id", { name: "x" });

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/removed.*reload/i) });
  });

  it("explains a group that still has tools rather than echoing the API", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(
      new PlatformApiError("tools: CONFLICT — the group still has tools in it", 409),
    );

    const result = await deleteGroup("identity");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/move or remove/i);
  });

  it("does not leak an unexpected failure's text to the operator", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:8080"));

    const result = await createTool(TOOL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toMatch(/ECONNREFUSED/);
  });

  it("sends an explicit null note as null, so the API clears it", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await updateTool("t1", { note: null });

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    // Three states must survive the trip: absent leaves the note alone, null
    // clears it, a string sets it. Serialising an explicit null as "absent"
    // would make a note impossible to remove.
    expect(JSON.parse(String(init?.body))).toEqual({ note: null });
  });

  it("omits an absent note entirely rather than sending null", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await updateTool("t1", { name: "Renamed" });

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Renamed" });
  });

  it("sends an idempotency key on a create (a body write)", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await createTool(TOOL);

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toEqual(expect.any(String));
    expect(headers["idempotency-key"].length).toBeGreaterThan(0);
  });

  it("sends an idempotency key on a delete (the no-body path)", async () => {
    signedIn();
    vi.mocked(platformRequestWithMeta).mockResolvedValue({ data: {}, meta: null });

    await deleteTool("t1");

    const [, , init] = vi.mocked(platformRequestWithMeta).mock.calls[0];
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toEqual(expect.any(String));
    expect(headers["idempotency-key"].length).toBeGreaterThan(0);
  });
});
