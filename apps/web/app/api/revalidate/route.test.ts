import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { revalidateTag, revalidatePath } = vi.hoisted(() => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath }));

import { POST } from "./route";

const post = (body: unknown, secret?: string) =>
  POST(
    new Request("http://site.test/api/revalidate", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === undefined ? {} : { "x-cms-secret": secret }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  revalidateTag.mockClear();
  revalidatePath.mockClear();
  vi.stubEnv("CMS_WEBHOOK_SECRET", "s3cret");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/revalidate", () => {
  it("returns 401 without the secret, or with a wrong one, and revalidates nothing", async () => {
    expect((await post({ collection: "products" })).status).toBe(401);
    expect((await post({ collection: "products" }, "wrong")).status).toBe(401);
    expect((await post({ collection: "products" }, "s3cret-longer")).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("returns 401 when no secret is configured, even for an empty header", async () => {
    vi.stubEnv("CMS_WEBHOOK_SECRET", "");
    expect((await post({ collection: "products" }, "")).status).toBe(401);
  });

  it("returns 400 for an unknown collection, a malformed slug, or a non-JSON body", async () => {
    expect((await post({ collection: "doctors" }, "s3cret")).status).toBe(400);
    expect((await post({ collection: "products", slug: "a/b" }, "s3cret")).status).toBe(400);
    expect((await post("not json", "s3cret")).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("expires the collection tag and the umbrella tag, and the product's path and its old path", async () => {
    const res = await post({ collection: "products", slug: "roamie", previousSlug: "old-roamie" }, "s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: ["cms:products", "cms"] });
    expect(revalidateTag).toHaveBeenCalledWith("cms:products", { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith("cms", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/products/roamie");
    expect(revalidatePath).toHaveBeenCalledWith("/products/old-roamie");
  });

  it("revalidates only tags for collections without their own pages", async () => {
    for (const collection of ["team-members", "principles", "beliefs", "open-source-projects"]) {
      expect((await post({ collection, slug: "x" }, "s3cret")).status).toBe(200);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).toHaveBeenCalledTimes(8);
  });
});
