import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./auth/platform-token", () => ({ resolvePlatformApiToken: async () => ({ token: "operator-token" }) }));

import { startRecoveryOperation } from "./recovery-api";

describe("recovery API transport", () => {
  it("uses the operator bearer token and forwards the same idempotency key", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "https://secrets.example");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "openbao-verified-backup-0123456789abcdef01234567", operation: "backup", phase: "Pending", createdAt: "2026-09-27T05:51:11Z" }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await startRecoveryOperation("backup", "550e8400-e29b-41d4-a716-446655440000");
      expect(result.phase).toBe("Pending");
      expect(fetch).toHaveBeenCalledWith("https://secrets.example/api/recovery/jobs", expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.objectContaining({ authorization: "Bearer operator-token" }), body: JSON.stringify({ operation: "backup", idempotencyKey: "550e8400-e29b-41d4-a716-446655440000" }) }));
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});
