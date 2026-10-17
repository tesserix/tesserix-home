import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAddresses } from "./location";
vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());
it("preserves the approved storefront host over the internal connection", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("QUESTIONNAIRES_LOCATION_LOCAL", "true");
  const address = {
    description: "Public venue",
    line1: "Venue Street",
    city: "Bhubaneswar",
    region: "Odisha",
    postal: "751001",
    country: "IN",
  };
  const server = createServer((req, res) => {
    res.setHeader("Connection", "close");
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(req.url).toBe(
      "/api/locations/autocomplete?q=Public+venue&country=IN",
    );
    if (req.headers.host !== "mark8ly.com") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          address,
          { ...address, country: "AU" },
          { ...address, line1: "x".repeat(201) },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(18207, "127.0.0.1", resolve),
  );
  try {
    expect(
      await fetchAddresses("Public venue", "IN", new AbortController().signal),
    ).toEqual([address]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it.each([
  [302, '{"data":[]}', "Location unavailable"],
  [200, "x".repeat(65537), "Location response too large"],
  [200, "not json", "Unexpected token"],
])("fails safely on upstream status/body %s", async (status, body, message) => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("QUESTIONNAIRES_LOCATION_LOCAL", "true");
  const server = createServer((_req, res) => {
    res.setHeader("Connection", "close");
    res.writeHead(status, { Location: "https://example.invalid" });
    res.end(body);
  });
  await new Promise<void>((resolve) =>
    server.listen(18207, "127.0.0.1", resolve),
  );
  try {
    await expect(
      fetchAddresses("Public venue", "IN", new AbortController().signal),
    ).rejects.toThrow(message);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it("honours cancellation without following another host", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("QUESTIONNAIRES_LOCATION_LOCAL", "true");
  const signal = AbortSignal.abort();
  await expect(fetchAddresses("Public venue", "IN", signal)).rejects.toThrow(
    /abort/i,
  );
});
