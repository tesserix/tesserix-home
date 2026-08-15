import { afterEach, describe, expect, it } from "vitest";
import { GET, dynamic } from "./route";

const KEYS = [
  "OPENPANEL_CLIENT_ID",
  "OPENPANEL_API_URL",
  "OPENPANEL_SCRIPT_URL",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("GET /api/analytics-config", () => {
  it("is excluded from the static prerender so the pod env is read per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns the OpenPanel config from the runtime environment", async () => {
    process.env.OPENPANEL_CLIENT_ID = "home-client-id";
    process.env.OPENPANEL_API_URL = "https://analytics.tesserix.app/api";
    process.env.OPENPANEL_SCRIPT_URL = "https://analytics.tesserix.app/op1.js";

    await expect(GET().json()).resolves.toEqual({
      clientId: "home-client-id",
      apiUrl: "https://analytics.tesserix.app/api",
      scriptUrl: "https://analytics.tesserix.app/op1.js",
    });
  });

  it("returns a null clientId when analytics is not configured", async () => {
    await expect(GET().json()).resolves.toMatchObject({ clientId: null });
  });

  it("is never cached, so a client id added after rollout is picked up", () => {
    expect(GET().headers.get("cache-control")).toContain("no-store");
  });
});
