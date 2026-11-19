import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { getProducts } from "./products";
import { getBeliefs, getOpenSource, getPrinciples, getTeam } from "./site";
import { fallbackProducts } from "./fallback/products";
import { fallbackTeam } from "./fallback/site";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", `${name}.json`), "utf8")) as { docs: unknown[] };

let overrides: Record<string, unknown> = {};
let status = 200;
const fetchMock = vi.fn(async (url: string) => {
  const name = new URL(url).pathname.replace("/api/", "");
  return new Response(JSON.stringify(overrides[name] ?? fixture(name)), { status });
});

beforeEach(() => {
  overrides = {};
  status = 200;
  fetchMock.mockClear();
  error.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CMS_URL", "http://cms.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("products from the CMS", () => {
  it("asks for published docs of the tesserix tenant, sorted by order", async () => {
    await getProducts();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://cms.test/api/products?where[tenant.slug][equals]=tesserix&depth=1&limit=0&sort=order",
    );
  });

  it("maps the mark8ly doc to today's Product shape", async () => {
    const p = (await getProducts()).mark8ly;
    expect(p.slug).toBe("mark8ly");
    expect(p.icon).toBe("ShoppingBag");
    expect(p.features).toEqual([{ icon: "Palette", title: "A storefront worth opening", description: "A theme that feels considered." }]);
    expect(p.media?.site).toEqual({
      src: "https://storage.googleapis.com/b/tesserix/mark8ly-storefront.jpg",
      alt: "The Mark8ly marketing homepage",
      width: 1568,
      height: 682,
      orientation: "landscape",
    });
    expect(p.media?.screenshots).toBeUndefined();
    expect(p.listings).toEqual({
      ios: { url: "", artworkSrc: "/badges/app-store-badge.svg" },
      android: { url: "https://play.google.com/store/apps/details?id=com.mark8ly.admin", artworkSrc: "/badges/google-play-badge.png" },
    });
    expect(p.pricingUrl).toBe("https://mark8ly.com/#pricing");
    expect(p.eta).toBeUndefined();
    expect(p.operatingSystem).toBeUndefined();
    expect(p.vendorListing).toBeUndefined();
  });

  it("keys products by slug in `order`", async () => {
    expect(Object.keys(await getProducts())).toEqual(["mark8ly", "roamie", "dwellm8"]);
  });

  it("maps a coming-soon product without media even if the CMS carries one", async () => {
    const p = (await getProducts()).dwellm8;
    expect(p.status).toBe("coming-soon");
    expect(p.media).toBeUndefined();
    expect(p.eta).toBe("Early 2027");
  });

  it("treats null arrays as empty", async () => {
    const p = (await getProducts()).dwellm8;
    expect(p.features).toEqual([]);
    expect(p.benefits).toEqual([]);
    expect(p.listings).toBeUndefined();
  });

  it("prefixes CMS_URL onto relative media paths and marks portrait shots", async () => {
    const shots = (await getProducts()).roamie.media?.screenshots;
    expect(shots).toHaveLength(3);
    expect(shots?.[0]).toEqual({
      src: "http://cms.test/api/media/file/roamie-app-talk.png",
      alt: "Roamie talk",
      width: 1080,
      height: 1920,
      orientation: "portrait",
    });
  });

  it("falls back to the static products on HTTP 500 and logs the failure once", async () => {
    status = 500;
    expect(await getProducts()).toBe(fallbackProducts);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("products");
  });

  it("falls back on a timeout or network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await getProducts()).toBe(fallbackProducts);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("falls back silently when CMS_URL is unset", async () => {
    vi.stubEnv("CMS_URL", "");
    expect(await getProducts()).toBe(fallbackProducts);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("site content from the CMS", () => {
  it("maps team photos to the profile size and falls back to /team/<slug>.jpg", async () => {
    const team = await getTeam();
    expect(team[0].photo).toBe("https://storage.googleapis.com/b/tesserix/mahesh-1000x1000.webp");
    expect(team[0].bio).toBe("Cloud architect.");
    expect(team[1].photo).toBe("/team/samyak-r.jpg");
    expect(team[1].bio).toBeUndefined();
  });

  it("maps beliefs, principles and open-source projects in order", async () => {
    expect(await getPrinciples()).toEqual([
      { title: "Small on purpose", body: "We're a small team by choice." },
      { title: "Opinionated by default", body: "Good tools make choices." },
    ]);
    expect((await getBeliefs()).map((b) => b.label)).toEqual(["Specialized > generic", "Humans reply"]);
    expect(await getOpenSource()).toEqual([
      { name: "sandboxctl", description: "One-command local Kubernetes sandbox." },
      { name: "cloudnav", description: "Keyboard-driven multi-cloud TUI." },
    ]);
  });

  it("falls back per collection", async () => {
    overrides["team-members"] = { nope: true };
    expect(await getTeam()).toBe(fallbackTeam);
    expect((await getPrinciples()).length).toBe(2);
  });
});

describe("getProduct", () => {
  it("returns undefined for a slug that is only an Object.prototype member", async () => {
    const { getProduct } = await import("./products");
    expect(await getProduct("constructor")).toBeUndefined();
    expect(await getProduct("mark8ly")).toBeDefined();
  });
});
