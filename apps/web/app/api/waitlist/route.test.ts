import { beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackProducts } from "@/lib/cms/fallback/products";

const { subscribe, getProducts } = vi.hoisted(() => ({ subscribe: vi.fn(), getProducts: vi.fn() }));
vi.mock("@/lib/db/product-waitlist", () => ({ subscribeToWaitlist: subscribe }));
vi.mock("@/lib/cms/products", async (importOriginal) => ({ ...(await importOriginal<object>()), getProducts }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://site.test/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never);

beforeEach(() => {
  subscribe.mockReset().mockResolvedValue(undefined);
  getProducts.mockReset().mockResolvedValue({
    ...fallbackProducts,
    newthing: { ...fallbackProducts.kora, slug: "newthing", title: "New Thing" },
  });
});

describe("POST /api/waitlist", () => {
  it("accepts a product the CMS publishes even when the static fallback does not know it", async () => {
    const res = await post({ productSlug: "newthing", email: "a@b.co" });
    expect(res.status).toBe(200);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ productSlug: "newthing" }));
  });

  it("rejects a slug no product has", async () => {
    expect((await post({ productSlug: "nope", email: "a@b.co" })).status).toBe(404);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
