import { describe, expect, it } from "vitest";
import { submitQuestionnaire } from "@tesserix/questionnaires/server";
const headers = {
  "Content-Type": "application/json",
  Origin: "https://questionnaire.tesserix.app",
  "Idempotency-Key": "00000000-0000-4000-8000-000000000001",
  "X-Questionnaire-Client": "00000000-0000-4000-8000-000000000002",
};
const request = (body: unknown, extra: Record<string, string> = {}) =>
  new Request(
    "https://questionnaire.tesserix.app/api/questionnaires/vending-customers",
    {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    },
  );
describe("public questionnaire submission boundary", () => {
  it("refuses unknown forms before any database access", async () => {
    expect((await submitQuestionnaire(request({}), "other")).status).toBe(404);
  });
  it.each(["https://evil.example", "null", ""])(
    "rejects an untrusted origin %s",
    async (origin) => {
      expect(
        (
          await submitQuestionnaire(
            request({}, { Origin: origin }),
            "vending-customers",
          )
        ).status,
      ).toBe(403);
    },
  );
  it("requires a stable random submission key", async () => {
    expect(
      (
        await submitQuestionnaire(
          request({}, { "Idempotency-Key": "1" }),
          "vending-customers",
        )
      ).status,
    ).toBe(400);
  });
  it("requires a browser abuse-prevention identifier", async () => {
    expect(
      (
        await submitQuestionnaire(
          request({}, { "X-Questionnaire-Client": "" }),
          "vending-customers",
        )
      ).status,
    ).toBe(400);
  });
  it("rejects oversized streamed bodies", async () => {
    expect(
      (
        await submitQuestionnaire(
          request({ comments: "x".repeat(17000) }),
          "vending-customers",
        )
      ).status,
    ).toBe(413);
  });
  it("rejects invalid answers without storing contact data", async () => {
    const r = await submitQuestionnaire(
      request({ contactEmail: "private@example.org" }),
      "vending-customers",
    );
    expect(r.status).toBe(422);
    expect(await r.text()).not.toContain("private@example.org");
  });
  it("requires JSON content type", async () => {
    expect(
      (
        await submitQuestionnaire(
          request({}, { "Content-Type": "text/plain" }),
          "vending-customers",
        )
      ).status,
    ).toBe(415);
  });
});
