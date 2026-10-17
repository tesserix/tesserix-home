import { afterEach, expect, it, vi } from "vitest";
import { loadCountries, fetchAddresses, lookupLocation } from "./location";
vi.mock("server-only", () => ({}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("uses the existing catalog and retains its country currency association", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      data: [{ code: "CA", name: "Canada", currency_code: "CAD" }],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await loadCountries()).toEqual([
    { code: "CA", name: "Canada", currency: "CAD" },
  ]);
  expect(String(fetcher.mock.calls[0][0])).toContain(
    "/api/v1/locations/countries",
  );
});
it("keeps known countries usable when the catalog is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect((await loadCountries()).find((c) => c.code === "JP")?.currency).toBe(
    "JPY",
  );
});
it("bounds and filters external suggestions and never forwards caller credentials", async () => {
  const address = {
    description: "Sample gym",
    line1: "1 Example St",
    city: "Melbourne",
    region: "Victoria",
    postal: "3000",
    country: "AU",
  };
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      data: [
        address,
        { ...address, country: "US" },
        { ...address, line1: "x".repeat(201) },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await fetchAddresses("Example", "AU", new AbortController().signal),
  ).toEqual([address]);
  expect(fetcher.mock.calls[0][1].headers).toEqual({ Host: "mark8ly.com" });
  expect(fetcher.mock.calls[0][1].redirect).toBe("error");
});
it.each([
  ["https://evil.example", { q: "Example", country: "AU" }, 403],
  ["https://questionnaire.tesserix.app", { q: "a", country: "AU" }, 422],
  [
    "https://questionnaire.tesserix.app",
    { q: "Example", country: "AU", url: "http://metadata.google.internal" },
    422,
  ],
])(
  "rejects invalid lookup before external or database access",
  async (origin, body, status) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const r = await lookupLocation(
      new Request(
        "https://questionnaire.tesserix.app/api/questionnaires/location",
        {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Questionnaire-Client": "00000000-0000-4000-8000-000000000001",
          },
          body: JSON.stringify(body),
        },
      ),
    );
    expect(r.status).toBe(status);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("returns a generic unavailable response without exposing credentials when admission is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("QUESTIONNAIRES_DB_PASSWORD", "");
  const response = await lookupLocation(
    new Request(
      "https://questionnaire.tesserix.app/api/questionnaires/location",
      {
        method: "POST",
        headers: {
          Origin: "https://questionnaire.tesserix.app",
          "Content-Type": "application/json",
          "X-Questionnaire-Client": "00000000-0000-4000-8000-000000000001",
        },
        body: JSON.stringify({ q: "Example venue", country: "AU" }),
      },
    ),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("enter the address manually");
  expect(fetch).not.toHaveBeenCalled();
});
