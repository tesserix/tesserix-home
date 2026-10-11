import { beforeEach, expect, it, vi } from "vitest";
import { resolveUsageUserNames } from "./user-names";
const fetchEntities = vi.hoisted(() => vi.fn());
vi.mock("@/lib/platform-api", () => ({ fetchProductEntities: fetchEntities }));
beforeEach(() => fetchEntities.mockReset());
const account = (id: string, label: string, source = "kora", type = "users") => ({ id: `${source}:${id}`, label, source, type });
const page = (data: ReturnType<typeof account>[], total = data.length) => ({ data, pagination: { page: 1, limit: 100, total } });
it("resolves only exact Kora user IDs and never attributes unknown traffic", async () => {
  fetchEntities.mockResolvedValue(page([account("a", "Asha"), account("b", "Other", "other"), account("c", "Rice", "kora", "foods"), account("", "Unknown"), account("d", "Unrelated")]));
  expect(await resolveUsageUserNames("kora", ["a", "b", "c", ""])).toEqual({ a: "Asha" });
  expect(fetchEntities).toHaveBeenCalledWith("kora", "users", undefined, 1, 100, expect.any(AbortSignal));
});
it("does not mix identities when no product or another product is selected", async () => {
  expect(await resolveUsageUserNames(undefined, ["a"])).toEqual({});
  expect(await resolveUsageUserNames("other", ["a"])).toEqual({});
  expect(fetchEntities).not.toHaveBeenCalled();
});
it("continues to later pages and stops once requested users are found", async () => {
  fetchEntities.mockResolvedValueOnce(page([account("other", "Other")], 3)).mockResolvedValueOnce(page([account("a", "Asha")], 3));
  expect(await resolveUsageUserNames("kora", ["a"])).toEqual({ a: "Asha" });
  expect(fetchEntities).toHaveBeenCalledTimes(2);
});
it("preserves found names when a subsequent directory read fails", async () => {
  fetchEntities.mockResolvedValueOnce(page([account("a", "Asha")], 2)).mockRejectedValueOnce(new Error("unavailable"));
  expect(await resolveUsageUserNames("kora", ["a", "deleted"])).toEqual({ a: "Asha" });
});
it("bounds directory reads and does not invent missing account names", async () => {
  fetchEntities.mockResolvedValue(page([account("other", "Other")], 100000));
  expect(await resolveUsageUserNames("kora", ["deleted"])).toEqual({});
  expect(fetchEntities).toHaveBeenCalledTimes(10);
});
it("does not read the directory for empty or unattributed rows", async () => {
  expect(await resolveUsageUserNames("kora", [""])).toEqual({});
  expect(fetchEntities).not.toHaveBeenCalled();
});
it("returns a plain object serializable across the server/client boundary", async () => {
  fetchEntities.mockResolvedValue(page([account("a", "Asha")]));
  const result = await resolveUsageUserNames("kora", ["a"]);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
});
it("rejects unqualified and foreign-prefixed identities even if their source claims Kora", async () => {
  fetchEntities.mockResolvedValue(page([
    { ...account("a", "Unqualified"), id: "a" },
    { ...account("a", "Foreign"), id: "other:a" },
  ]));
  expect(await resolveUsageUserNames("kora", ["a"])).toEqual({});
});
