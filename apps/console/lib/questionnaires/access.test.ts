import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@tesserix/platform-auth";
const state = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
  }),
  headers: async () => new Headers(),
}));
import { requireQuestionnaireViewer } from "./access";
import { GET } from "@/app/api/questionnaires/route";
beforeEach(() => {
  state.cookie = "";
  vi.stubEnv("SESSION_ENCRYPT_KEY", "00000000000000000000000000000001");
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.stubEnv("PLATFORM_OPERATOR_EMAILS", "operator@example.org");
});
afterEach(() => vi.unstubAllEnvs());
describe("questionnaire report access with real encrypted sessions", () => {
  it("denies anonymous report reads before any response query", async () => {
    const r = await GET(
      new Request("https://console.tesserix.app/api/questionnaires"),
    );
    expect(r.status).toBe(404);
  });
  it("denies a signed non-operator even with platform roles", async () => {
    state.cookie = await signSession({
      sub: "foreign-subject",
      email: "foreign@example.org",
      roles: ["platform"],
    });
    await expect(requireQuestionnaireViewer()).rejects.toThrow("access denied");
    expect(
      (
        await GET(
          new Request("https://console.tesserix.app/api/questionnaires"),
        )
      ).status,
    ).toBe(404);
  });
  it("denies a signed operator missing platform permission", async () => {
    state.cookie = await signSession({
      sub: "operator",
      email: "operator@example.org",
      roles: ["read"],
    });
    await expect(requireQuestionnaireViewer()).rejects.toThrow();
  });
  it("accepts a signed allowlisted operator with platform permission", async () => {
    state.cookie = await signSession({
      sub: "operator",
      email: "operator@example.org",
      roles: ["platform"],
    });
    expect((await requireQuestionnaireViewer()).sub).toBe("operator");
  });
});
