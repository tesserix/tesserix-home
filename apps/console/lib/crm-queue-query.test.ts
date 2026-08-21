import { describe, expect, it } from "vitest";
import { queueQuery } from "./crm-queue-query";

const params = (f: Parameters<typeof queueQuery>[0], limit = 100, cursor?: string) =>
  Object.fromEntries(queueQuery(f, limit, cursor).entries());

describe("queueQuery", () => {
  it("sends plain values for ordinary filters", () => {
    expect(params({ product: "mark8ly", stage: "contacted", owner: "sam" })).toEqual({
      product: "mark8ly", stage: "contacted", owner: "sam", limit: "100",
    });
  });

  it("turns the unassigned-product sentinel into product_unset", () => {
    const out = params({ product: "__unassigned__" });
    expect(out.product_unset).toBe("true");
    expect(out.product).toBeUndefined();
  });

  it("turns the unknown-country sentinel into country_unset", () => {
    const out = params({ country: "__unknown__" });
    expect(out.country_unset).toBe("true");
    expect(out.country).toBeUndefined();
  });

  it("turns the unknown-followers sentinel into followers_unset", () => {
    const out = params({ followers: "__unknown__" });
    expect(out.followers_unset).toBe("true");
    expect(out.followers).toBeUndefined();
  });

  it("never sends an axis and its _unset twin together", () => {
    const out = queueQuery({ product: "__unassigned__" }, 100);
    expect(out.has("product")).toBe(false);
    expect(out.has("product_unset")).toBe(true);
  });

  it("omits absent filters entirely rather than sending empty strings", () => {
    expect(params({})).toEqual({ limit: "100" });
  });

  it("includes the cursor only when one is given", () => {
    expect(params({}, 100, "abc").cursor).toBe("abc");
    expect(params({}, 100).cursor).toBeUndefined();
  });
});
